import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { GustModel, OrnsteinUhlenbeck, Random, ValueNoise, hashString } from '../src/core/random.js'
import { ManualClock, ManualDriver, Scheduler, SimulationClock } from '../src/simulator/clock.js'
import { FaultController } from '../src/simulator/faults.js'
import { createInstrumentChannels } from '../src/simulator/instruments.js'
import { encodeRateOfTurn } from '../src/nmea0183/ais/messages.js'
import { BitWriter, decodeSixBit, encodeSixBit, sixBitValueOf } from '../src/nmea0183/ais/sixbit.js'
import { ALL_ENABLED, FIXED_SAMPLE_INTERVALS } from './helpers.js'

describe('seeded randomness', () => {
  it('reproduces the same sequence from the same seed', () => {
    const first = new Random(12345)
    const second = new Random(12345)
    const a = Array.from({ length: 200 }, () => first.next())
    const b = Array.from({ length: 200 }, () => second.next())
    assert.deepEqual(a, b)
  })

  it('produces a different sequence from a different seed', () => {
    const a = Array.from({ length: 50 }, () => new Random(1).next())
    const b = Array.from({ length: 50 }, () => new Random(2).next())
    assert.notDeepEqual(a, b)
  })

  it('stays inside [0, 1)', () => {
    const random = new Random(7)
    for (let index = 0; index < 20_000; index += 1) {
      const value = random.next()
      assert.ok(value >= 0 && value < 1, `out of range: ${value}`)
    }
  })

  it('is roughly uniform', () => {
    const random = new Random(99)
    const buckets = new Array<number>(10).fill(0)
    const samples = 100_000
    for (let index = 0; index < samples; index += 1) {
      const bucket = Math.min(9, Math.floor(random.next() * 10))
      buckets[bucket] = (buckets[bucket] ?? 0) + 1
    }
    for (const [index, count] of buckets.entries()) {
      assert.ok(Math.abs(count - samples / 10) < samples / 40, `bucket ${index} had ${count}`)
    }
  })

  it('derives independent, reproducible substreams by name', () => {
    const parent = new Random(12345)
    const wind = parent.derive('wind')
    const depth = parent.derive('depth')
    assert.notEqual(wind.seed, depth.seed)

    const again = new Random(12345).derive('wind')
    assert.deepEqual(
      Array.from({ length: 20 }, () => wind.next()),
      Array.from({ length: 20 }, () => again.next()),
    )
    // Drawing from one substream must not disturb another.
    const depthFirst = depth.next()
    const depthAgain = new Random(12345).derive('depth')
    for (let index = 0; index < 5; index += 1) new Random(12345).derive('wind').next()
    assert.equal(depthFirst, depthAgain.next())
  })

  it('resets to its starting sequence', () => {
    const random = new Random(4321)
    const first = [random.next(), random.next(), random.next()]
    random.reset()
    assert.deepEqual([random.next(), random.next(), random.next()], first)
  })

  it('hashes strings deterministically to 32 bits', () => {
    assert.equal(hashString('wind'), hashString('wind'))
    assert.notEqual(hashString('wind'), hashString('depth'))
    assert.ok(hashString('anything') >= 0 && hashString('anything') <= 0xffffffff)
  })

  it('produces integers, booleans and picks within bounds', () => {
    const random = new Random(31)
    for (let index = 0; index < 1000; index += 1) {
      const value = random.integer(3, 7)
      assert.ok(Number.isInteger(value) && value >= 3 && value <= 7)
    }
    assert.equal(random.integer(5, 5), 5)
    assert.equal(random.chance(0), false)
    assert.equal(random.chance(1), true)
    assert.ok(['a', 'b', 'c'].includes(random.pick(['a', 'b', 'c'])))
    assert.throws(() => random.pick([]), /non-empty/)
  })

  it('produces a normal distribution with the requested mean and spread', () => {
    const random = new Random(1234)
    const samples = Array.from({ length: 50_000 }, () => random.gaussian(5, 2))
    const mean = samples.reduce((total, value) => total + value, 0) / samples.length
    const variance = samples.reduce((total, value) => total + (value - mean) ** 2, 0) / samples.length
    assert.ok(Math.abs(mean - 5) < 0.05, `mean ${mean}`)
    assert.ok(Math.abs(Math.sqrt(variance) - 2) < 0.05, `sd ${Math.sqrt(variance)}`)
    assert.ok(samples.every((value) => Number.isFinite(value)))
  })
})

describe('Ornstein-Uhlenbeck process', () => {
  it('reverts to its mean and stays near it', () => {
    const process = new OrnsteinUhlenbeck(new Random(1), {
      mean: 10,
      sigma: 1,
      timeConstantSeconds: 20,
      initial: 40,
    })
    for (let index = 0; index < 4000; index += 1) process.step(0.05)
    assert.ok(Math.abs(process.value - 10) < 5, `settled at ${process.value}`)
  })

  it('moves smoothly rather than jumping', () => {
    const process = new OrnsteinUhlenbeck(new Random(2), { mean: 0, sigma: 5, timeConstantSeconds: 30 })
    let previous = process.value
    let largestStep = 0
    for (let index = 0; index < 2000; index += 1) {
      const next = process.step(0.05)
      largestStep = Math.max(largestStep, Math.abs(next - previous))
      previous = next
    }
    // With sigma 5 and a 30 s time constant the per-step diffusion is about
    // 0.29, so even a rare 3-sigma draw stays far below the standing deviation
    // of the process. A white-noise source would routinely step by 10 or more.
    assert.ok(largestStep < 2, `largest 50 ms step was ${largestStep}`)
  })

  it('respects hard bounds', () => {
    const process = new OrnsteinUhlenbeck(new Random(3), {
      mean: 0,
      sigma: 20,
      timeConstantSeconds: 2,
      min: -1,
      max: 1,
    })
    for (let index = 0; index < 2000; index += 1) {
      const value = process.step(0.05)
      assert.ok(value >= -1 && value <= 1, `escaped bounds: ${value}`)
    }
  })

  it('has a stationary spread close to sigma, independent of the step size', () => {
    for (const dt of [0.05, 0.5]) {
      const process = new OrnsteinUhlenbeck(new Random(11), { mean: 0, sigma: 3, timeConstantSeconds: 10 })
      const samples: number[] = []
      for (let index = 0; index < 40_000; index += 1) {
        const value = process.step(dt)
        if (index > 2000) samples.push(value)
      }
      const mean = samples.reduce((total, value) => total + value, 0) / samples.length
      const sd = Math.sqrt(samples.reduce((total, value) => total + (value - mean) ** 2, 0) / samples.length)
      assert.ok(Math.abs(sd - 3) < 0.6, `dt=${dt} gave sd ${sd}`)
    }
  })
})

describe('gust model', () => {
  it('stays non-negative and near the mean wind', () => {
    const gusts = new GustModel(new Random(5), {
      meanKnots: 14,
      sigmaKnots: 1.5,
      timeConstantSeconds: 60,
      gustKnots: 5,
      gustIntervalSeconds: 40,
      gustDurationSeconds: 8,
    })
    let total = 0
    let count = 0
    let maximum = 0
    for (let index = 0; index < 40_000; index += 1) {
      const speed = gusts.step(0.05)
      assert.ok(speed >= 0, `negative wind speed ${speed}`)
      total += speed
      count += 1
      maximum = Math.max(maximum, speed)
    }
    const mean = total / count
    assert.ok(Math.abs(mean - 14) < 3, `mean wind ${mean}`)
    assert.ok(maximum > 16, 'gusts should exceed the base wind')
    assert.ok(maximum < 45, `implausible gust of ${maximum} kn`)
  })

  it('gusts rather than jumping between random values', () => {
    const gusts = new GustModel(new Random(6), {
      meanKnots: 20,
      sigmaKnots: 2,
      timeConstantSeconds: 45,
      gustKnots: 8,
      gustIntervalSeconds: 30,
      gustDurationSeconds: 6,
    })
    let previous = gusts.step(0.05)
    let largestStep = 0
    let sawGust = false
    for (let index = 0; index < 20_000; index += 1) {
      const next = gusts.step(0.05)
      largestStep = Math.max(largestStep, Math.abs(next - previous))
      previous = next
      if (gusts.gusting) sawGust = true
    }
    assert.ok(sawGust, 'no gust occurred in 1000 s')
    assert.ok(largestStep < 1.5, `wind jumped by ${largestStep} kn in one 50 ms step`)
  })
})

describe('value noise', () => {
  it('is smooth, bounded and repeatable for the same coordinate', () => {
    const noise = new ValueNoise(2024)
    let previous = noise.fractal(0)
    for (let x = 0; x < 200; x += 0.05) {
      const value = noise.fractal(x)
      assert.ok(value >= -1.01 && value <= 1.01, `out of range at ${x}: ${value}`)
      assert.ok(Math.abs(value - previous) < 0.35, `jumped at ${x}`)
      previous = value
    }
    assert.equal(noise.fractal(3.25), noise.fractal(3.25))
    assert.equal(new ValueNoise(2024).sample(7.5), noise.sample(7.5))
  })

  it('handles non-finite coordinates', () => {
    const noise = new ValueNoise(1)
    assert.ok(Number.isFinite(noise.sample(Number.NaN)))
    assert.ok(Number.isFinite(noise.fractal(Number.POSITIVE_INFINITY)))
  })
})

describe('scheduler', () => {
  it('runs each task at its own rate', () => {
    const scheduler = new Scheduler(0)
    const counts = { fast: 0, slow: 0 }
    scheduler.add({ id: 'fast', intervalMs: 200, run: () => (counts.fast += 1) })
    scheduler.add({ id: 'slow', intervalMs: 1000, run: () => (counts.slow += 1) })

    // Advanced the way a driver would, in small slices.
    for (let time = 50; time <= 10_000; time += 50) scheduler.advanceTo(time)
    assert.equal(counts.fast, 50)
    assert.equal(counts.slow, 10)
  })

  it('passes the scheduled time, not the time it happened to run', () => {
    const scheduler = new Scheduler(0)
    const times: number[] = []
    scheduler.add({ id: 'tick', intervalMs: 250, run: (at) => times.push(at) })
    // Advance in one lump: the run times must still be evenly spaced.
    scheduler.advanceTo(750)
    assert.deepEqual(times, [250, 500, 750])
  })

  it('orders tasks due at the same instant by their declared order', () => {
    const scheduler = new Scheduler(0)
    const sequence: string[] = []
    scheduler.add({ id: 'sentence', intervalMs: 100, order: 3, run: () => sequence.push('sentence') })
    scheduler.add({ id: 'physics', intervalMs: 100, order: 0, run: () => sequence.push('physics') })
    scheduler.add({ id: 'sensor', intervalMs: 100, order: 2, run: () => sequence.push('sensor') })

    scheduler.advanceTo(100)
    assert.deepEqual(sequence, ['physics', 'sensor', 'sentence'])
  })

  it('does not replay hundreds of times after a long stall', () => {
    const scheduler = new Scheduler(0)
    let runs = 0
    scheduler.add({ id: 'tick', intervalMs: 10, run: () => (runs += 1) })
    // Simulate a ten-second stall.
    scheduler.advanceTo(10_000)
    assert.ok(runs <= 3, `caught up ${runs} times`)
    // The task must still be on its original phase afterwards.
    runs = 0
    scheduler.advanceTo(10_100)
    assert.ok(runs > 0 && runs <= 11, `resumed with ${runs} runs`)
  })

  it('rebases rather than replaying when time goes backwards', () => {
    const scheduler = new Scheduler(1_000)
    let runs = 0
    scheduler.add({ id: 'tick', intervalMs: 100, run: () => (runs += 1) })
    for (let time = 1_100; time <= 1_500; time += 100) scheduler.advanceTo(time)
    const before = runs
    scheduler.advanceTo(500)
    assert.equal(runs, before, 'no runs while rewinding')
  })

  it('can enable, disable, retime and remove tasks', () => {
    const scheduler = new Scheduler(0)
    let runs = 0
    scheduler.add({ id: 'tick', intervalMs: 100, run: () => (runs += 1) })
    assert.ok(scheduler.has('tick'))

    scheduler.setEnabled('tick', false)
    for (let time = 100; time <= 1_000; time += 100) scheduler.advanceTo(time)
    assert.equal(runs, 0)

    scheduler.setEnabled('tick', true)
    for (let time = 1_100; time <= 2_000; time += 100) scheduler.advanceTo(time)
    assert.ok(runs > 0)

    runs = 0
    scheduler.setInterval('tick', 500)
    for (let time = 2_100; time <= 4_000; time += 100) scheduler.advanceTo(time)
    // The new interval is rebased from now, so the task next runs at 2.5 s and
    // then every 500 ms: 2500, 3000, 3500, 4000.
    assert.equal(runs, 4, 'four runs at the new 500 ms interval')

    scheduler.remove('tick')
    assert.equal(scheduler.has('tick'), false)
  })

  it('rejects a non-positive interval', () => {
    const scheduler = new Scheduler(0)
    assert.throws(() => scheduler.add({ id: 'bad', intervalMs: 0, run: () => {} }), /positive finite/)
    assert.throws(() => scheduler.add({ id: 'bad', intervalMs: Number.NaN, run: () => {} }), /positive finite/)
  })

  it('reports the shortest interval so a driver can size its heartbeat', () => {
    const scheduler = new Scheduler(0)
    scheduler.add({ id: 'a', intervalMs: 1000, run: () => {} })
    scheduler.add({ id: 'b', intervalMs: 200, run: () => {} })
    assert.equal(scheduler.minimumIntervalMs(9999), 200)
    assert.equal(new Scheduler(0).minimumIntervalMs(50), 50, 'falls back when empty')
  })

  it('reports per-task statistics', () => {
    const scheduler = new Scheduler(0)
    scheduler.add({ id: 'tick', intervalMs: 100, run: () => {} })
    for (let time = 50; time <= 500; time += 50) scheduler.advanceTo(time)
    const stats = scheduler.stats()
    assert.equal(stats.length, 1)
    assert.equal(stats[0]?.runs, 5)
    assert.equal(stats[0]?.lastRunMs, 500)
    assert.equal(stats[0]?.enabled, true)
  })
})

describe('clocks', () => {
  it('a manual clock only moves when told to', () => {
    const clock = new ManualClock(1_000)
    assert.equal(clock.now(), 1_000)
    clock.advance(250)
    assert.equal(clock.now(), 1_250)
    clock.set(9_000)
    assert.equal(clock.now(), 9_000)
  })

  it('a simulation clock can scale the passage of time', () => {
    let wall = 0
    const clock = new SimulationClock(100_000, 4, () => wall)
    assert.equal(clock.now(), 100_000)
    wall = 1_000
    assert.equal(clock.now(), 104_000, 'four times as fast')
    assert.equal(clock.elapsedSeconds(), 4)
  })

  it('a manual driver advances the scheduler in slices', () => {
    const clock = new ManualClock(0)
    const scheduler = new Scheduler(0)
    const driver = new ManualDriver(scheduler, clock)
    let runs = 0
    scheduler.add({ id: 'tick', intervalMs: 100, run: () => (runs += 1) })

    driver.advance(1_000)
    assert.equal(clock.now(), 1_000)
    assert.equal(runs, 10, 'no catch-up limiting when advanced in slices')
  })
})

describe('instrument channels', () => {
  const now = 1_000_000

  it('reports its own age since the last reading', () => {
    const channels = createInstrumentChannels(FIXED_SAMPLE_INTERVALS, ALL_ENABLED)
    assert.equal(channels.wind.ageMs(now), null, 'no reading yet')
    channels.wind.update(
      { apparentAngleDegrees: 60, apparentSpeedKnots: 12, trueAngleDegrees: 90, trueDirectionDegrees: 240, trueSpeedKnots: 10 },
      now,
    )
    assert.equal(channels.wind.ageMs(now), 0)
    assert.equal(channels.wind.ageMs(now + 120), 120)
  })

  it('lets different instruments carry genuinely different data ages', () => {
    const channels = createInstrumentChannels(FIXED_SAMPLE_INTERVALS, ALL_ENABLED)
    channels.wind.update(
      { apparentAngleDegrees: 60, apparentSpeedKnots: 12, trueAngleDegrees: 90, trueDirectionDegrees: 240, trueSpeedKnots: 10 },
      now - 120,
    )
    channels.heading.update(
      { headingTrue: 145, headingMagnetic: 159.5, variationDegrees: -14.5, deviationDegrees: 0, rateOfTurnDegPerMin: 0 },
      now - 40,
    )
    channels.temperature.update({ waterTemperatureC: 16.5 }, now - 4_200)

    assert.equal(channels.wind.ageMs(now), 120)
    assert.equal(channels.heading.ageMs(now), 40)
    assert.equal(channels.temperature.ageMs(now), 4_200)
  })

  it('a frozen channel keeps its old value and stops ageing forward', () => {
    const channels = createInstrumentChannels(FIXED_SAMPLE_INTERVALS, ALL_ENABLED)
    channels.depth.update({ depthBelowTransducerMeters: 12, offsetMeters: 0.6, depthBelowSurfaceMeters: 12.6 }, now)
    channels.depth.fault = 'frozen'
    channels.depth.update({ depthBelowTransducerMeters: 30, offsetMeters: 0.6, depthBelowSurfaceMeters: 30.6 }, now + 5_000)

    assert.equal(channels.depth.value?.depthBelowTransducerMeters, 12, 'value did not change')
    assert.equal(channels.depth.ageMs(now + 5_000), 5_000, 'and the data is visibly stale')
    assert.ok(channels.depth.available, 'but the sentence keeps flowing')
  })

  it('an offline channel stops contributing sentences', () => {
    const channels = createInstrumentChannels(FIXED_SAMPLE_INTERVALS, ALL_ENABLED)
    channels.gps.update(
      {
        time: new Date(now),
        latitude: 41.95,
        longitude: -70.3,
        altitudeMeters: 2,
        geoidSeparationMeters: 34,
        fixQuality: 1,
        satellitesUsed: 10,
        hdop: 0.9,
        pdop: 1.5,
        vdop: 1.2,
        cogDegrees: 145,
        sogKnots: 6,
        satellites: [],
      },
      now,
    )
    assert.ok(channels.gps.available)
    channels.gps.fault = 'offline'
    assert.equal(channels.gps.available, false)
    assert.ok(channels.gps.value, 'the last reading is still retained')
  })

  it('an invalid channel is still available, but not valid', () => {
    const channels = createInstrumentChannels(FIXED_SAMPLE_INTERVALS, ALL_ENABLED)
    channels.temperature.update({ waterTemperatureC: 16.5 }, now)
    channels.temperature.fault = 'invalid'
    assert.ok(channels.temperature.available)
    assert.equal(channels.temperature.valid, false)
  })

  it('a disabled channel refuses new readings', () => {
    const channels = createInstrumentChannels(FIXED_SAMPLE_INTERVALS, ALL_ENABLED)
    channels.wind.enabled = false
    channels.wind.update(
      { apparentAngleDegrees: 60, apparentSpeedKnots: 12, trueAngleDegrees: 90, trueDirectionDegrees: 240, trueSpeedKnots: 10 },
      now,
    )
    assert.equal(channels.wind.value, null)
    assert.equal(channels.wind.available, false)
  })

  it('reports a status suitable for the control API', () => {
    const channels = createInstrumentChannels(FIXED_SAMPLE_INTERVALS, ALL_ENABLED)
    channels.heading.update(
      { headingTrue: 145, headingMagnetic: 159.5, variationDegrees: -14.5, deviationDegrees: 0, rateOfTurnDegPerMin: 0 },
      now,
    )
    const status = channels.heading.status(now + 250)
    assert.equal(status.id, 'heading')
    assert.equal(status.enabled, true)
    assert.equal(status.fault, 'none')
    assert.equal(status.ageMs, 250)
    assert.equal(status.sampleIntervalMs, 100)
    assert.equal(status.sampleRateHz, 10)
    assert.equal(status.updates, 1)
    assert.equal(status.updatedAt, new Date(now).toISOString())
  })
})

describe('fault controller', () => {
  function build(): { controller: FaultController; channels: ReturnType<typeof createInstrumentChannels> } {
    const channels = createInstrumentChannels(FIXED_SAMPLE_INTERVALS, ALL_ENABLED)
    const controller = new FaultController(channels, new Random(1))
    return { controller, channels }
  }

  it('fires timeline events at the right simulated second', () => {
    const { controller, channels } = build()
    controller.setTimeline({
      events: [
        { atSeconds: 10, action: { type: 'instrument', instrument: 'wind', fault: 'frozen' } },
        { atSeconds: 20, action: { type: 'instrument', instrument: 'wind', fault: 'none' } },
      ],
    })

    controller.update(5)
    assert.equal(channels.wind.fault, 'none')
    controller.update(10)
    assert.equal(channels.wind.fault, 'frozen')
    controller.update(19.9)
    assert.equal(channels.wind.fault, 'frozen')
    controller.update(20)
    assert.equal(channels.wind.fault, 'none')
  })

  it('injects exactly the requested number of bad checksums', () => {
    const { controller } = build()
    controller.apply({ type: 'badChecksum', count: 3 })
    const decisions = Array.from({ length: 10 }, () => controller.nextWireFault())
    assert.equal(decisions.filter((decision) => decision.corruptChecksum).length, 3)
    assert.equal(decisions.slice(3).every((decision) => !decision.corruptChecksum), true)
  })

  it('injects exactly the requested number of malformed sentences', () => {
    const { controller } = build()
    controller.apply({ type: 'malformed', count: 1 })
    const decisions = Array.from({ length: 5 }, () => controller.nextWireFault())
    assert.equal(decisions.filter((decision) => decision.malform).length, 1)
  })

  it('never damages one sentence in both ways at once', () => {
    const { controller } = build()
    controller.apply({ type: 'badChecksum', count: 5 })
    controller.apply({ type: 'malformed', count: 5 })
    for (let index = 0; index < 5; index += 1) {
      const decision = controller.nextWireFault()
      assert.equal(decision.corruptChecksum && decision.malform, false)
    }
  })

  it('expires a probabilistic wire fault after its duration', () => {
    const { controller } = build()
    controller.update(0)
    controller.apply({ type: 'badChecksum', probability: 1, durationSeconds: 10 })
    assert.equal(controller.nextWireFault().corruptChecksum, true)
    controller.update(11)
    assert.equal(controller.nextWireFault().corruptChecksum, false)
  })

  it('clears everything on clearAll', () => {
    const { controller, channels } = build()
    controller.apply({ type: 'instrument', instrument: 'gps', fault: 'offline' })
    controller.apply({ type: 'badChecksum', count: 5 })
    controller.apply({ type: 'clearAll' })
    assert.equal(channels.gps.fault, 'none')
    assert.equal(controller.nextWireFault().corruptChecksum, false)
  })

  it('loops a timeline, resetting faults each time round', () => {
    const { controller, channels } = build()
    const events: string[] = []
    const looping = new FaultController(channels, new Random(1), (entry) => events.push(entry.note))
    looping.setTimeline({
      loopSeconds: 30,
      events: [{ atSeconds: 10, action: { type: 'instrument', instrument: 'depth', fault: 'frozen' }, note: 'depth stale' }],
    })

    looping.update(10)
    assert.equal(channels.depth.fault, 'frozen')
    looping.update(31)
    assert.equal(channels.depth.fault, 'none', 'the loop resets faults')
    looping.update(41)
    assert.equal(channels.depth.fault, 'frozen', 'and replays them')
    assert.deepEqual(events, ['depth stale', 'depth stale'])
    void controller
  })

  it('records a bounded history and a snapshot', () => {
    const { controller, channels } = build()
    controller.setTimeline({
      events: [{ atSeconds: 1, action: { type: 'instrument', instrument: 'wind', fault: 'offline' }, note: 'wind lost' }],
    })
    controller.update(2)
    const snapshot = controller.snapshot()
    assert.equal(snapshot.history.length, 1)
    assert.equal(snapshot.history[0]?.note, 'wind lost')
    assert.equal(snapshot.pendingEvents, 0)
    assert.equal(channels.wind.fault, 'offline')
  })
})

describe('AIS six-bit encoding', () => {
  it('round-trips a bit string', () => {
    const bits = '000001000000000101011010111000110101011110111000101100'
    const { payload, fillBits } = encodeSixBit(bits)
    assert.equal(decodeSixBit(payload, fillBits), bits)
  })

  it('produces only printable characters outside the framing set', () => {
    const bits = Array.from({ length: 168 }, (_unused, index) => (index % 3 === 0 ? '1' : '0')).join('')
    const { payload } = encodeSixBit(bits)
    for (const character of payload) {
      const code = character.charCodeAt(0)
      assert.ok(code >= 0x30 && code <= 0x77, `unexpected payload character ${character}`)
      assert.ok(!'$!*,\\\r\n'.includes(character))
    }
  })

  it('reports the fill bits needed to reach a six-bit boundary', () => {
    assert.equal(encodeSixBit('1'.repeat(168)).fillBits, 0)
    assert.equal(encodeSixBit('1'.repeat(166)).fillBits, 2)
    assert.equal(encodeSixBit('').payload, '')
  })

  it('writes unsigned and signed fields at the requested width', () => {
    assert.equal(new BitWriter().unsigned(1, 6).toBitString(), '000001')
    assert.equal(new BitWriter().unsigned(63, 6).toBitString(), '111111')
    assert.equal(new BitWriter().signed(-1, 8).toBitString(), '11111111')
    assert.equal(new BitWriter().signed(-128, 8).toBitString(), '10000000')
    assert.equal(new BitWriter().signed(127, 8).toBitString(), '01111111')
  })

  it('clamps a signed value that will not fit rather than wrapping it', () => {
    assert.equal(new BitWriter().signed(500, 8).toBitString(), '01111111')
    assert.equal(new BitWriter().signed(-500, 8).toBitString(), '10000000')
  })

  it('handles non-finite input by writing zero', () => {
    assert.equal(new BitWriter().unsigned(Number.NaN, 6).toBitString(), '000000')
    assert.equal(new BitWriter().signed(Number.POSITIVE_INFINITY, 8).toBitString(), '00000000')
  })

  it('encodes text in the AIS six-bit alphabet, padded to width', () => {
    const writer = new BitWriter().text('AB', 3)
    assert.equal(writer.length, 18)
    assert.equal(writer.toBitString(), '000001000010000000', 'A=1, B=2, pad=@=0')
    assert.equal(sixBitValueOf('@'), 0)
    assert.equal(sixBitValueOf('A'), 1)
    assert.equal(sixBitValueOf('0'), 48)
  })

  it('encodes rate of turn with the AIS square-root scale', () => {
    assert.equal(encodeRateOfTurn(0), 0)
    assert.equal(encodeRateOfTurn(Number.NaN), -128, 'not available')
    // 4.733 * sqrt(30) is about 25.9.
    assert.equal(encodeRateOfTurn(30), 26)
    assert.equal(encodeRateOfTurn(-30), -26)
    assert.ok(Math.abs(encodeRateOfTurn(100_000)) <= 127)
  })
})
