import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSentence } from '../src/nmea0183/checksum.js'
import { getScenario, listScenarios } from '../src/scenarios/index.js'
import { SCENARIO_NAMES, isScenarioName } from '../src/scenarios/types.js'
import { SENSOR_FAILURE_TIMELINE } from '../src/scenarios/sensorFailure.js'
import { assertWellFormed, captureSentences, createTestEngine } from './helpers.js'
import type { BoatState } from '../src/types.js'

/** Sample the state repeatedly while the scenario runs. */
async function sample(scenario: string, seconds: number, stepSeconds = 1): Promise<BoatState[]> {
  const { engine, advance, stop } = await createTestEngine({ env: { SIM_SCENARIO: scenario } })
  const states: BoatState[] = []
  try {
    for (let elapsed = 0; elapsed < seconds; elapsed += stepSeconds) {
      advance(stepSeconds * 1000)
      states.push(structuredClone(engine.state))
    }
  } finally {
    await stop()
  }
  return states
}

const range = (values: number[]): { min: number; max: number; mean: number } => ({
  min: Math.min(...values),
  max: Math.max(...values),
  mean: values.reduce((total, value) => total + value, 0) / values.length,
})

describe('scenario registry', () => {
  it('registers all five scenarios', () => {
    assert.deepEqual(
      listScenarios().map((scenario) => scenario.name).sort(),
      [...SCENARIO_NAMES].sort(),
    )
  })

  it('gives each scenario a label, a description and highlights', () => {
    for (const scenario of listScenarios()) {
      assert.ok(scenario.label.length > 0, scenario.name)
      assert.ok(scenario.description.length > 20, scenario.name)
      assert.ok(scenario.highlights.length > 0, scenario.name)
    }
  })

  it('recognises scenario names', () => {
    assert.ok(isScenarioName('sensor-failure'))
    assert.equal(isScenarioName('sensorFailure'), false)
    assert.throws(() => getScenario('nope' as never), /Unknown scenario/)
  })
})

describe('every scenario', () => {
  for (const name of SCENARIO_NAMES) {
    it(`${name} produces only well-formed sentences`, async () => {
      const { engine, advance, stop } = await createTestEngine({
        env: { SIM_SCENARIO: name, NMEA_PROFILE: 'full', ENABLE_AIS: 'true' },
      })
      const captured = captureSentences(engine)
      const faultInjected = name === 'sensor-failure'
      try {
        // Long enough for the sensor-failure timeline to reach its wire faults.
        advance(faultInjected ? 210_000 : 120_000)
      } finally {
        captured.stop()
        await stop()
      }

      assert.ok(captured.lines.length > 500, `only ${captured.lines.length} sentences`)
      let malformed = 0
      for (const line of captured.lines) {
        if (faultInjected && parseSentence(line)?.valid !== true) {
          malformed += 1
          continue
        }
        assertWellFormed(line)
      }
      if (faultInjected) {
        assert.ok(malformed > 0, 'the sensor-failure scenario should inject broken sentences')
        assert.ok(malformed < captured.lines.length * 0.05, 'but only a handful of them')
      } else {
        assert.equal(malformed, 0)
      }
    })

    it(`${name} keeps every state value finite and in range`, async () => {
      const states = await sample(name, 90)
      for (const state of states) {
        assert.ok(Number.isFinite(state.position.latitude) && Math.abs(state.position.latitude) <= 90)
        assert.ok(Number.isFinite(state.position.longitude) && Math.abs(state.position.longitude) <= 180)
        assert.ok(state.navigation.sogKnots >= 0 && state.navigation.sogKnots < 60)
        assert.ok(state.navigation.speedThroughWaterKnots >= 0 && state.navigation.speedThroughWaterKnots < 60)
        assert.ok(state.navigation.headingTrue >= 0 && state.navigation.headingTrue < 360)
        assert.ok(state.navigation.cog >= 0 && state.navigation.cog < 360)
        assert.ok(state.wind.trueSpeedKnots >= 0 && state.wind.trueSpeedKnots < 120)
        assert.ok(state.wind.apparentSpeedKnots >= 0 && state.wind.apparentSpeedKnots < 140)
        assert.ok(state.wind.trueDirectionDegrees >= 0 && state.wind.trueDirectionDegrees < 360)
        assert.ok(state.wind.apparentAngleDegrees >= 0 && state.wind.apparentAngleDegrees < 360)
        assert.ok(state.environment.depthMeters > 0 && state.environment.depthMeters < 1000)
        assert.ok(state.environment.waterTemperatureC > -3 && state.environment.waterTemperatureC < 40)
        assert.ok(Math.abs(state.motion.heelDegrees ?? 0) < 60)
        assert.ok(Math.abs(state.extended.rateOfTurnDegPerMin) <= 600)
      }
    })
  }
})

describe('sailing', () => {
  it('starts at the advertised conditions', async () => {
    const states = await sample('sailing', 5)
    const first = states[0]
    assert.ok(first)
    assert.ok(Math.abs(first.navigation.sogKnots - 6.1) < 0.6, `SOG ${first.navigation.sogKnots}`)
    assert.ok(Math.abs(first.navigation.speedThroughWaterKnots - 5.8) < 0.5)
    assert.ok(Math.abs(first.navigation.headingTrue - 145) < 5)
    assert.ok(Math.abs(first.wind.trueSpeedKnots - 14) < 2)
    assert.ok(Math.abs(first.environment.depthMeters - 12) < 4)
  })

  it('makes speed over ground differ from speed through the water, because of the current', async () => {
    const states = await sample('sailing', 60)
    const differences = states.map((state) => state.navigation.sogKnots - state.navigation.speedThroughWaterKnots)
    assert.ok(range(differences).mean > 0.1, 'a fair current should show as SOG above STW')
  })

  it('heels to leeward and makes leeway while sailing', async () => {
    const states = await sample('sailing', 60)
    const heel = range(states.map((state) => state.motion.heelDegrees ?? 0))
    assert.ok(Math.abs(heel.mean) > 1, `mean heel ${heel.mean}`)
    assert.ok(Math.abs(heel.max) < 35)
  })

  it('varies heading and speed naturally rather than holding a constant', async () => {
    const states = await sample('sailing', 180)
    const headings = range(states.map((state) => state.navigation.headingTrue))
    const speeds = range(states.map((state) => state.navigation.speedThroughWaterKnots))
    assert.ok(headings.max - headings.min > 2, 'heading should wander')
    assert.ok(speeds.max - speeds.min > 0.2, 'speed should vary')
    assert.ok(speeds.max - speeds.min < 5, 'but not wildly')
  })

  it('gusts rather than jumping, and the apparent wind follows the true wind', async () => {
    const states = await sample('sailing', 300, 0.5)
    const trueSpeeds = states.map((state) => state.wind.trueSpeedKnots)
    let largestStep = 0
    for (let index = 1; index < trueSpeeds.length; index += 1) {
      largestStep = Math.max(largestStep, Math.abs((trueSpeeds[index] as number) - (trueSpeeds[index - 1] as number)))
    }
    assert.ok(largestStep < 4, `true wind stepped by ${largestStep} kn in half a second`)
    assert.ok(range(trueSpeeds).max - range(trueSpeeds).min > 2, 'and there should be gusts')

    // Apparent wind is derived, so it must move with the true wind, never
    // independently of it.
    for (const state of states) {
      const bound = state.wind.trueSpeedKnots + state.navigation.sogKnots + 0.01
      assert.ok(state.wind.apparentSpeedKnots <= bound, 'AWS cannot exceed TWS + SOG')
      assert.ok(state.wind.apparentSpeedKnots >= Math.abs(state.wind.trueSpeedKnots - state.navigation.sogKnots) - 0.01)
    }
  })
})

describe('cruising', () => {
  it('motors in the 18-25 kn band with limited heel', async () => {
    const states = await sample('cruising', 300, 2)
    const speeds = range(states.map((state) => state.navigation.speedThroughWaterKnots))
    assert.ok(speeds.min > 15, `slowest ${speeds.min}`)
    assert.ok(speeds.max < 28, `fastest ${speeds.max}`)

    const heel = range(states.map((state) => Math.abs(state.motion.heelDegrees ?? 0)))
    assert.ok(heel.max < 10, `heeled to ${heel.max}° under power`)
  })

  it('makes only small heading variations', async () => {
    const states = await sample('cruising', 120)
    const headings = states.map((state) => state.navigation.headingTrue)
    let largestStep = 0
    for (let index = 1; index < headings.length; index += 1) {
      const delta = Math.abs(((headings[index] as number) - (headings[index - 1] as number) + 540) % 360 - 180)
      largestStep = Math.max(largestStep, delta)
    }
    assert.ok(largestStep < 15, `heading jumped by ${largestStep}° in a second`)
  })

  it('makes no leeway under power', async () => {
    const states = await sample('cruising', 60)
    for (const state of states) {
      assert.equal(state.extended.leewayDegrees, 0)
    }
  })
})

describe('anchored', () => {
  it('holds speed over ground near zero', async () => {
    const states = await sample('anchored', 600, 5)
    const sog = range(states.map((state) => state.navigation.sogKnots))
    assert.ok(sog.mean < 0.8, `mean SOG ${sog.mean}`)
    assert.ok(sog.max < 2, `peak SOG ${sog.max}`)
  })

  it('still swings its head through a wide arc', async () => {
    const states = await sample('anchored', 900, 5)
    const headings = states.map((state) => state.navigation.headingTrue)
    const spread = Math.max(...headings) - Math.min(...headings)
    assert.ok(spread > 15, `heading only moved ${spread}°`)
  })

  it('drifts around the anchor without sailing away', async () => {
    const states = await sample('anchored', 900, 5)
    const first = states[0]
    assert.ok(first)
    for (const state of states) {
      const metresNorth = (state.position.latitude - first.position.latitude) * 111_000
      const metresEast = (state.position.longitude - first.position.longitude) * 111_000 * Math.cos((41.95 * Math.PI) / 180)
      const distance = Math.hypot(metresNorth, metresEast)
      assert.ok(distance < 200, `drifted ${distance.toFixed(0)} m from the anchorage`)
    }
  })

  it('keeps the wind active and the depth stable', async () => {
    const states = await sample('anchored', 600, 5)
    const wind = range(states.map((state) => state.wind.trueSpeedKnots))
    const depth = range(states.map((state) => state.environment.depthMeters))
    assert.ok(wind.mean > 3, 'the wind keeps blowing at anchor')
    assert.ok(depth.max - depth.min < 2, `depth varied by ${(depth.max - depth.min).toFixed(2)} m`)
  })

  it('reads the current as speed through the water while stopped over the ground', async () => {
    const states = await sample('anchored', 600, 5)
    const stw = range(states.map((state) => state.navigation.speedThroughWaterKnots))
    assert.ok(stw.mean > 0.1, 'water still flows past the hull')
    assert.ok(stw.mean < 2.5, `implausible STW at anchor: ${stw.mean}`)
  })
})

describe('storm', () => {
  it('blows a gale with big gusts', async () => {
    const states = await sample('storm', 600, 2)
    const wind = range(states.map((state) => state.wind.trueSpeedKnots))
    assert.ok(wind.mean > 25, `mean true wind ${wind.mean}`)
    assert.ok(wind.max > wind.mean + 6, 'gusts well above the mean')
    assert.ok(wind.max < 90, `implausible gust of ${wind.max} kn`)
  })

  it('varies heading and speed much more than the sailing scenario', async () => {
    const stormStates = await sample('storm', 300, 2)
    const sailingStates = await sample('sailing', 300, 2)

    const spread = (states: BoatState[], select: (state: BoatState) => number): number => {
      const values = states.map(select)
      return Math.max(...values) - Math.min(...values)
    }

    assert.ok(
      spread(stormStates, (state) => state.navigation.speedThroughWaterKnots) >
        spread(sailingStates, (state) => state.navigation.speedThroughWaterKnots),
      'storm speed should vary more',
    )
  })

  it('stays within survivable rather than cartoonish values', async () => {
    const states = await sample('storm', 300, 2)
    for (const state of states) {
      assert.ok(Math.abs(state.motion.heelDegrees ?? 0) < 50)
      assert.ok(state.navigation.speedThroughWaterKnots < 20)
      assert.ok(state.environment.depthMeters > 5)
      assert.ok((state.environment.airPressureHpa ?? 1013) < 1005, 'a gale comes with a low')
    }
  })
})

describe('sensor-failure', () => {
  it('declares a deterministic timeline covering every failure mode', () => {
    const kinds = SENSOR_FAILURE_TIMELINE.events.map((event) => event.action.type)
    assert.ok(kinds.includes('instrument'))
    assert.ok(kinds.includes('badChecksum'))
    assert.ok(kinds.includes('malformed'))
    assert.ok(kinds.includes('clearAll'))

    const faults = SENSOR_FAILURE_TIMELINE.events
      .filter((event) => event.action.type === 'instrument')
      .map((event) => (event.action as { instrument: string; fault: string }))
    assert.ok(faults.some((fault) => fault.instrument === 'wind' && fault.fault === 'frozen'))
    assert.ok(faults.some((fault) => fault.instrument === 'gps' && fault.fault === 'offline'))
    assert.ok(faults.some((fault) => fault.instrument === 'heading' && fault.fault === 'frozen'))
    assert.ok(faults.some((fault) => fault.instrument === 'depth' && fault.fault === 'frozen'))
    assert.ok(faults.some((fault) => fault.instrument === 'gps' && fault.fault === 'invalid'))
    assert.ok(SENSOR_FAILURE_TIMELINE.loopSeconds !== undefined, 'the timeline repeats')
  })

  it('freezes the wind at 20 s and restores it at 35 s', async () => {
    const { engine, advance, stop } = await createTestEngine({ env: { SIM_SCENARIO: 'sensor-failure' } })
    try {
      advance(15_000)
      assert.equal(engine.instrumentStatus().find((status) => status.id === 'wind')?.fault, 'none')

      advance(10_000) // t = 25 s
      const frozen = engine.state.wind.apparentSpeedKnots
      assert.equal(engine.instrumentStatus().find((status) => status.id === 'wind')?.fault, 'frozen')

      const beforeAge = engine.instrumentStatus().find((status) => status.id === 'wind')?.ageMs ?? 0
      advance(5_000) // t = 30 s, still frozen
      const afterAge = engine.instrumentStatus().find((status) => status.id === 'wind')?.ageMs ?? 0
      assert.ok(afterAge > beforeAge + 4_000, 'the wind reading is visibly going stale')
      void frozen

      advance(10_000) // t = 40 s
      assert.equal(engine.instrumentStatus().find((status) => status.id === 'wind')?.fault, 'none')
    } finally {
      await stop()
    }
  })

  it('takes GPS offline entirely, so position sentences stop', async () => {
    const { engine, advance, stop } = await createTestEngine({ env: { SIM_SCENARIO: 'sensor-failure' } })
    try {
      advance(55_000) // t = 55 s: GPS offline at 50 s
      const captured = captureSentences(engine)
      advance(10_000)
      captured.stop()

      assert.equal(
        captured.lines.filter((line) => line.includes('RMC') || line.includes('GGA') || line.includes('VTG')).length,
        0,
        'no position sentences while the GPS is offline',
      )
      assert.ok(captured.lines.some((line) => line.includes('MWV')), 'other instruments keep reporting')
    } finally {
      await stop()
    }
  })

  it('freezes the heading so HDT keeps transmitting the same value', async () => {
    const { engine, advance, stop } = await createTestEngine({ env: { SIM_SCENARIO: 'sensor-failure' } })
    try {
      advance(90_000) // t = 90 s: heading frozen at 85 s
      const captured = captureSentences(engine)
      advance(10_000)
      captured.stop()

      const headings = captured.lines.filter((line) => line.includes('HDT'))
      assert.ok(headings.length > 10, 'HDT is still being transmitted')
      assert.equal(new Set(headings.map((line) => line.split(',')[1])).size, 1, 'but the value never changes')
    } finally {
      await stop()
    }
  })

  it('injects bad checksums and a malformed sentence, then recovers', async () => {
    const { engine, advance, stop } = await createTestEngine({ env: { SIM_SCENARIO: 'sensor-failure' } })
    const captured = captureSentences(engine)
    try {
      advance(210_000)
    } finally {
      captured.stop()
      await stop()
    }

    const badChecksums = captured.lines.filter((line) => {
      const parsed = parseSentence(line)
      return parsed !== null && !parsed.valid
    })
    const malformed = captured.lines.filter((line) => parseSentence(line) === null)

    assert.equal(badChecksums.length, 5, 'exactly the five injected bad checksums')
    assert.equal(malformed.length, 1, 'exactly the one injected malformed sentence')

    // After the timeline's clearAll everything is healthy again.
    assert.deepEqual(
      engine.instrumentStatus().filter((status) => status.fault !== 'none').map((status) => status.id),
      [],
    )
  })

  it('replays exactly the same faults at the same times for the same seed', async () => {
    const run = async (): Promise<string[]> => {
      const { engine, advance, stop } = await createTestEngine({ env: { SIM_SCENARIO: 'sensor-failure' } })
      try {
        advance(210_000)
        return engine.simulationWorld.faults.snapshot().history.map((entry) => `${entry.atSeconds}:${entry.note}`)
      } finally {
        await stop()
      }
    }

    const first = await run()
    const second = await run()
    assert.ok(first.length >= SENSOR_FAILURE_TIMELINE.events.length)
    assert.deepEqual(first, second)
  })
})
