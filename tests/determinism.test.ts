import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SCENARIO_NAMES } from '../src/scenarios/types.js'
import { captureSentences, createTestEngine } from './helpers.js'

/**
 * `SIM_SEED=12345` must reproduce substantially the same run.
 *
 * The bar set here is stricter than "substantially": with a manual clock and a
 * seeded PRNG the sentence stream is bit-for-bit identical, which makes the
 * simulator usable as a fixture for a consumer's regression tests.
 */

async function streamFor(options: {
  scenario: string
  seed: string
  seconds: number
  profile?: string
}): Promise<string[]> {
  const env: Record<string, string> = {
    SIM_SCENARIO: options.scenario,
    SIM_SEED: options.seed,
  }
  if (options.profile) env['NMEA_PROFILE'] = options.profile

  const { engine, advance, stop } = await createTestEngine({ env })
  const captured = captureSentences(engine)
  try {
    advance(options.seconds * 1000)
  } finally {
    captured.stop()
    await stop()
  }
  return captured.lines
}

describe('deterministic seeded scenarios', () => {
  for (const scenario of SCENARIO_NAMES) {
    it(`${scenario} replays identically for the same seed`, async () => {
      const first = await streamFor({ scenario, seed: '12345', seconds: 60 })
      const second = await streamFor({ scenario, seed: '12345', seconds: 60 })

      assert.ok(first.length > 200, `only ${first.length} sentences`)
      assert.equal(first.length, second.length, 'the same number of sentences')
      assert.deepEqual(first, second, 'and byte-for-byte the same content')
    })
  }

  it('produces a different run for a different seed', async () => {
    const a = await streamFor({ scenario: 'sailing', seed: '12345', seconds: 60 })
    const b = await streamFor({ scenario: 'sailing', seed: '99999', seconds: 60 })

    assert.equal(a.length, b.length, 'the same sentences at the same rates')
    assert.notDeepEqual(a, b, 'but different values')

    // The runs should diverge substantially, not in one field of one sentence.
    const differing = a.filter((line, index) => line !== b[index]).length
    assert.ok(differing > a.length * 0.5, `only ${differing} of ${a.length} sentences differed`)
  })

  it('starts every seed from the same advertised conditions', async () => {
    const { engine: first, stop: stopFirst } = await createTestEngine({ env: { SIM_SEED: '1' } })
    const { engine: second, stop: stopSecond } = await createTestEngine({ env: { SIM_SEED: '424242' } })
    try {
      // The scenario defines the starting point; the seed drives what happens
      // after it, so both runs must begin in the same place.
      assert.equal(first.state.navigation.headingTrue, second.state.navigation.headingTrue)
      assert.equal(first.state.wind.trueDirectionDegrees, second.state.wind.trueDirectionDegrees)
      assert.equal(first.state.position.latitude, second.state.position.latitude)
    } finally {
      await stopFirst()
      await stopSecond()
    }
  })

  it('reproduces the same state, not just the same sentences', async () => {
    const snapshot = async (): Promise<string> => {
      const { engine, advance, stop } = await createTestEngine({ env: { SIM_SCENARIO: 'storm' } })
      try {
        advance(180_000)
        return JSON.stringify(engine.state)
      } finally {
        await stop()
      }
    }
    assert.equal(await snapshot(), await snapshot())
  })

  it('keeps determinism across a scenario switch', async () => {
    const run = async (): Promise<string> => {
      const { engine, advance, stop } = await createTestEngine({ env: { SIM_SCENARIO: 'sailing' } })
      try {
        advance(30_000)
        engine.setScenario('storm')
        advance(30_000)
        engine.setScenario('anchored')
        advance(30_000)
        return JSON.stringify(engine.state)
      } finally {
        await stop()
      }
    }
    assert.equal(await run(), await run())
  })

  it('is unaffected by the profile in use for the sentences it shares', async () => {
    const minimal = await streamFor({ scenario: 'sailing', seed: '12345', seconds: 30, profile: 'minimal' })
    const garmin = await streamFor({ scenario: 'sailing', seed: '12345', seconds: 30, profile: 'garmin-wifi' })

    const rmcFrom = (lines: string[]): string[] => lines.filter((line) => line.startsWith('$GPRMC'))
    assert.deepEqual(rmcFrom(minimal), rmcFrom(garmin), 'the same physics produces the same RMC either way')
    assert.ok(garmin.length > minimal.length, 'the wider profile simply carries more sentences')
  })
})
