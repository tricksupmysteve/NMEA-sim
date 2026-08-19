import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ControlApiServer } from '../src/api/server.js'
import { loadConfig } from '../src/config.js'
import { silentLogger } from '../src/core/logger.js'
import { SimulatorEngine } from '../src/engine.js'
import { parseSentence } from '../src/nmea0183/checksum.js'
import { assertWellFormed, connectClient, requestJson, waitFor } from './helpers.js'

/**
 * End-to-end: start the real engine on a real socket, connect as Matey would,
 * and check what actually arrives on the wire.
 *
 * These tests run on the wall clock (not the manual one) because the point is
 * to exercise the real timers and the real TCP path. Rates are raised so the
 * whole file finishes in a couple of seconds.
 */

interface RunningSimulator {
  engine: SimulatorEngine
  port: number
  stop(): Promise<void>
}

async function startSimulator(env: Record<string, string> = {}): Promise<RunningSimulator> {
  const config = loadConfig({
    argv: ['--quiet'],
    env: {
      SIM_SEED: '12345',
      NMEA_HOST: '127.0.0.1',
      NMEA_PORT: '0',
      HTTP_ENABLED: 'false',
      QUIET: 'true',
      LOG_LEVEL: 'silent',
      // Speed everything up so the test does not wait five seconds for MTW.
      NMEA_RATE_MTW: '5',
      NMEA_RATE_MWD: '5',
      NMEA_RATE_DPT: '5',
      NMEA_RATE_RMC: '5',
      NMEA_RATE_GGA: '5',
      NMEA_RATE_VTG: '5',
      NMEA_RATE_VHW: '5',
      ...env,
    },
    envFileDir: null,
  })

  const engine = new SimulatorEngine(config, { logger: silentLogger })
  await engine.start()
  const address = engine.tcpAddress()
  assert.ok(address, 'the TCP server did not bind')

  return {
    engine,
    port: address.port,
    stop: () => engine.stop(),
  }
}

/** The sentence formatters the garmin-wifi profile is required to produce. */
const REQUIRED_FORMATTERS = ['RMC', 'GGA', 'VTG', 'HDT', 'VHW', 'MWV', 'MWD', 'DPT', 'MTW'] as const

describe('end to end over TCP', () => {
  it('streams valid NMEA to a client that connects and sends nothing', async () => {
    const simulator = await startSimulator()
    const client = await connectClient(simulator.port)
    try {
      await client.waitForLines(40, 8_000)

      for (const line of client.lines) {
        assertWellFormed(line)
      }

      const formatters = new Set(client.lines.map((line) => parseSentence(line)?.formatter))
      for (const formatter of REQUIRED_FORMATTERS) {
        assert.ok(formatters.has(formatter), `never saw ${formatter}; saw ${[...formatters].join(', ')}`)
      }
    } finally {
      await client.close()
      await simulator.stop()
    }
  })

  it('produces the talkers the Garmin-style Wi-Fi profile advertises', async () => {
    const simulator = await startSimulator()
    const client = await connectClient(simulator.port)
    try {
      await client.waitForLines(60, 8_000)
      const addresses = new Set(client.lines.map((line) => parseSentence(line)?.address))
      for (const address of ['GPRMC', 'GPGGA', 'GPVTG', 'IIHDT', 'IIVHW', 'WIMWV', 'WIMWD', 'SDDPT', 'WIMTW']) {
        assert.ok(addresses.has(address), `never saw $${address}`)
      }
    } finally {
      await client.close()
      await simulator.stop()
    }
  })

  it('serves several clients the same stream simultaneously', async () => {
    const simulator = await startSimulator()
    const clients = await Promise.all([
      connectClient(simulator.port),
      connectClient(simulator.port),
      connectClient(simulator.port),
    ])
    try {
      await waitFor(() => simulator.engine.clients().length === 3, 4_000, 'three clients')
      await Promise.all(clients.map((client) => client.waitForLines(25, 8_000)))

      for (const client of clients) {
        for (const line of client.lines) assertWellFormed(line)
      }

      // Every client sees the same sentences in the same order, allowing for
      // each having connected a moment apart.
      const [first, second] = clients
      assert.ok(first && second)
      const overlap = first.lines.filter((line) => second.lines.includes(line))
      assert.ok(overlap.length > 10, `only ${overlap.length} sentences in common`)
      assert.equal(simulator.engine.clients().length, 3)
    } finally {
      await Promise.all(clients.map((client) => client.close()))
      await simulator.stop()
    }
  })

  it('keeps streaming to a client that reconnects', async () => {
    const simulator = await startSimulator()
    try {
      const first = await connectClient(simulator.port)
      await first.waitForLines(5, 5_000)
      await first.close()
      await waitFor(() => simulator.engine.clients().length === 0, 4_000, 'the client to be reaped')

      const second = await connectClient(simulator.port)
      await second.waitForLines(5, 5_000)
      for (const line of second.lines) assertWellFormed(line)
      await second.close()
    } finally {
      await simulator.stop()
    }
  })

  it('switches scenario without dropping the connection', async () => {
    const simulator = await startSimulator()
    const api = new ControlApiServer(simulator.engine, {
      host: '127.0.0.1',
      port: 0,
      token: null,
      corsOrigin: '*',
      logger: silentLogger,
    })
    await api.start()
    const apiPort = api.address()?.port ?? 0

    const client = await connectClient(simulator.port)
    try {
      await client.waitForLines(15, 6_000)
      const before = client.lines.length

      const response = await requestJson(apiPort, 'POST', '/scenario/storm')
      assert.equal(response.status, 200)

      await client.waitForLines(before + 20, 6_000)
      assert.equal(simulator.engine.currentScenario, 'storm')
      assert.equal(simulator.engine.clients().length, 1, 'the connection survived the switch')

      for (const line of client.lines) assertWellFormed(line)
      assert.ok(simulator.engine.state.wind.trueSpeedKnots > 20, 'the storm really arrived')
    } finally {
      await client.close()
      await api.stop()
      await simulator.stop()
    }
  })

  it('shuts down gracefully, closing the client socket', async () => {
    const simulator = await startSimulator()
    const client = await connectClient(simulator.port)
    await client.waitForLines(5, 5_000)

    const closed = new Promise<void>((resolve) => client.socket.once('close', () => resolve()))
    await simulator.stop()
    await closed

    assert.equal(simulator.engine.isRunning, false)
    await assert.rejects(connectClient(simulator.port), /ECONNREFUSED/)
  })

  it('stops emitting when an instrument is disabled and resumes when it returns', async () => {
    const simulator = await startSimulator()
    const client = await connectClient(simulator.port)
    try {
      await client.waitForLines(20, 6_000)
      assert.ok(client.lines.some((line) => line.includes('DPT')))

      simulator.engine.setInstrumentEnabled('depth', false)
      const marker = client.lines.length
      await client.waitForLines(marker + 30, 6_000)
      assert.equal(
        client.lines.slice(marker + 5).filter((line) => line.includes('DPT')).length,
        0,
        'depth sentences stopped',
      )

      simulator.engine.setInstrumentEnabled('depth', true)
      const resumed = client.lines.length
      await client.waitForLines(resumed + 30, 6_000)
      assert.ok(client.lines.slice(resumed).some((line) => line.includes('DPT')), 'depth sentences came back')
    } finally {
      await client.close()
      await simulator.stop()
    }
  })

  it('shows different sentences arriving at genuinely different ages', async () => {
    const simulator = await startSimulator({
      // Back to the documented defaults so the rates really do differ.
      NMEA_RATE_MTW: '0.5',
      NMEA_RATE_RMC: '1',
      NMEA_RATE_GGA: '1',
      NMEA_RATE_VTG: '1',
      NMEA_RATE_MWD: '1',
      NMEA_RATE_DPT: '1',
      NMEA_RATE_VHW: '2',
    })
    const client = await connectClient(simulator.port)
    try {
      await client.waitForLines(60, 8_000)

      const counts = new Map<string, number>()
      for (const line of client.lines) {
        const formatter = parseSentence(line)?.formatter ?? '?'
        counts.set(formatter, (counts.get(formatter) ?? 0) + 1)
      }

      const hdt = counts.get('HDT') ?? 0
      const rmc = counts.get('RMC') ?? 0
      assert.ok(hdt > rmc * 2, `HDT (${hdt}) should arrive far more often than RMC (${rmc})`)

      const ages = simulator.engine.sentenceAges()
      const hdtAge = ages.find((entry) => entry.id === 'HDT')?.ageMs ?? Number.POSITIVE_INFINITY
      const mtwAge = ages.find((entry) => entry.id === 'MTW')?.ageMs ?? 0
      assert.ok(hdtAge < 400, `HDT should be fresh, was ${hdtAge} ms old`)
      assert.ok(mtwAge >= 0)

      const instruments = simulator.engine.instrumentStatus()
      const headingAge = instruments.find((instrument) => instrument.id === 'heading')?.ageMs ?? 0
      const temperatureAge = instruments.find((instrument) => instrument.id === 'temperature')?.ageMs ?? 0
      assert.ok(headingAge <= temperatureAge + 50, 'the compass updates faster than the thermometer')
    } finally {
      await client.close()
      await simulator.stop()
    }
  })

  it('never emits an invalid sentence over a sustained run', async () => {
    const simulator = await startSimulator({ NMEA_PROFILE: 'full', ENABLE_AIS: 'true', SIM_TIME_SCALE: '20' })
    const client = await connectClient(simulator.port)
    try {
      await client.waitForLines(400, 10_000)
      for (const line of client.lines) assertWellFormed(line)

      const stats = simulator.engine.stats()
      assert.equal(stats.rejectedSentences, 0, 'no sentence was rejected by the encoder')
      assert.equal(stats.faultedSentences, 0, 'no faults are injected outside the sensor-failure scenario')
      assert.ok(stats.sentencesEmitted >= client.lines.length)
    } finally {
      await client.close()
      await simulator.stop()
    }
  })
})
