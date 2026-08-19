/**
 * Shared test helpers.
 *
 * Two things matter here:
 *
 *  - `fixedChannels()` builds an instrument set with exact, known readings, so
 *    sentence tests can assert on real field values rather than on whatever the
 *    simulation happened to produce;
 *  - `createTestEngine()` builds an engine on a manual clock, so a scenario
 *    replays identically with no wall-clock timing and no flakiness.
 */

import assert from 'node:assert/strict'
import net from 'node:net'
import { loadConfig, type SimulatorConfig } from '../src/config.js'
import { silentLogger } from '../src/core/logger.js'
import { SimulatorEngine } from '../src/engine.js'
import { parseSentence } from '../src/nmea0183/checksum.js'
import { NmeaEncoder } from '../src/nmea0183/encoder.js'
import type { EncodeContext, EncoderSettings } from '../src/nmea0183/types.js'
import { ManualClock, ManualDriver } from '../src/simulator/clock.js'
import {
  createInstrumentChannels,
  type InstrumentChannels,
  type InstrumentIntervals,
  type InstrumentToggles,
} from '../src/simulator/instruments.js'
import type { BoatState } from '../src/types.js'

export const FIXED_TIME = new Date('2026-03-14T09:26:53.500Z')

export const FIXED_SAMPLE_INTERVALS: InstrumentIntervals = {
  gps: 250,
  heading: 100,
  wind: 200,
  depth: 500,
  waterSpeed: 250,
  temperature: 2000,
  pressure: 5000,
  attitude: 100,
  ais: 5000,
}

export const ALL_ENABLED: InstrumentToggles = {
  gps: true,
  heading: true,
  wind: true,
  depth: true,
  waterSpeed: true,
  temperature: true,
  pressure: true,
  attitude: true,
  ais: true,
}

export const TEST_ENCODER_SETTINGS: EncoderSettings = {
  talkers: {
    RMC: 'GP',
    GGA: 'GP',
    GLL: 'GP',
    VTG: 'GP',
    ZDA: 'GP',
    GSA: 'GP',
    GSV: 'GP',
    HDT: 'II',
    HDM: 'II',
    HDG: 'II',
    ROT: 'II',
    VHW: 'II',
    VLW: 'II',
    MWV: 'WI',
    MWVT: 'WI',
    MWD: 'WI',
    DPT: 'SD',
    DBT: 'SD',
    MTW: 'WI',
    XDR: 'YX',
    MDA: 'WI',
    VDO: 'AI',
    VDM: 'AI',
  },
  // 14.5° west.
  magneticVariationDegrees: -14.5,
  ownShip: { mmsi: 366123456, name: 'MATEY SIM', callSign: 'MTY1', shipType: 36 },
  coordinateDecimals: 4,
  timeDecimals: 2,
}

/**
 * Instrument channels populated with exact, known readings.
 *
 * Position 41° 57.0000' N, 070° 18.0000' W. Heading 145° true, SOG 6.1 kn,
 * STW 5.8 kn, true wind 14 kn from 240°, depth 12.0 m below a 0.6 m transducer.
 */
export function fixedChannels(atMs = FIXED_TIME.getTime()): InstrumentChannels {
  const channels = createInstrumentChannels(FIXED_SAMPLE_INTERVALS, ALL_ENABLED)

  channels.gps.force(
    {
      time: FIXED_TIME,
      latitude: 41.95,
      longitude: -70.3,
      altitudeMeters: 2.4,
      geoidSeparationMeters: 34.2,
      fixQuality: 1,
      satellitesUsed: 11,
      hdop: 0.8,
      pdop: 1.6,
      vdop: 1.3,
      cogDegrees: 148.2,
      sogKnots: 6.1,
      satellites: [
        { prn: 3, elevationDegrees: 45, azimuthDegrees: 123, signalToNoiseDb: 44, used: true },
        { prn: 7, elevationDegrees: 12, azimuthDegrees: 21, signalToNoiseDb: 33, used: true },
        { prn: 11, elevationDegrees: 68, azimuthDegrees: 305, signalToNoiseDb: 48, used: true },
        { prn: 19, elevationDegrees: 30, azimuthDegrees: 88, signalToNoiseDb: 39, used: true },
        { prn: 24, elevationDegrees: 55, azimuthDegrees: 210, signalToNoiseDb: 41, used: true },
      ],
    },
    atMs,
  )

  channels.heading.force(
    {
      headingTrue: 145,
      headingMagnetic: 159.5,
      variationDegrees: -14.5,
      deviationDegrees: 0.5,
      rateOfTurnDegPerMin: 12.4,
    },
    atMs,
  )

  channels.wind.force(
    {
      apparentAngleDegrees: 67.8,
      apparentSpeedKnots: 15.1,
      trueAngleDegrees: 95,
      trueDirectionDegrees: 240,
      trueSpeedKnots: 14,
    },
    atMs,
  )

  channels.depth.force(
    { depthBelowTransducerMeters: 12, offsetMeters: 0.6, depthBelowSurfaceMeters: 12.6 },
    atMs,
  )

  channels.waterSpeed.force(
    { speedThroughWaterKnots: 5.8, headingTrue: 145, headingMagnetic: 159.5, logTotalNm: 1234.5, logTripNm: 12.3 },
    atMs,
  )

  channels.temperature.force({ waterTemperatureC: 16.5 }, atMs)
  channels.pressure.force({ airPressureHpa: 1014, airTemperatureC: 19, relativeHumidityPercent: 68 }, atMs)
  channels.attitude.force({ heelDegrees: -8.4, pitchDegrees: 1.2, rateOfTurnDegPerMin: 12.4 }, atMs)
  channels.ais.force(
    {
      own: {
        mmsi: 366123456,
        name: 'MATEY SIM',
        latitude: 41.95,
        longitude: -70.3,
        cogDegrees: 148.2,
        sogKnots: 6.1,
        headingTrue: 145,
        rateOfTurnDegPerMin: 12.4,
        navigationStatus: 8,
      },
      targets: [
        {
          mmsi: 235098765,
          name: 'NORDIC STAR',
          latitude: 41.97,
          longitude: -70.28,
          cogDegrees: 32.5,
          sogKnots: 11.2,
          headingTrue: 33,
          rateOfTurnDegPerMin: 0,
          navigationStatus: 0,
        },
      ],
    },
    atMs,
  )

  return channels
}

/** A minimal but complete `BoatState` matching {@link fixedChannels}. */
export function fixedState(): BoatState {
  return {
    timestamp: FIXED_TIME,
    position: { latitude: 41.95, longitude: -70.3, altitude: 2.4, fixQuality: 1, satellites: 11, hdop: 0.8 },
    navigation: { headingTrue: 145, headingMagnetic: 159.5, cog: 148.2, sogKnots: 6.1, speedThroughWaterKnots: 5.8 },
    wind: { trueDirectionDegrees: 240, trueSpeedKnots: 14, apparentAngleDegrees: 67.8, apparentSpeedKnots: 15.1 },
    environment: { depthMeters: 12.6, waterTemperatureC: 16.5, airPressureHpa: 1014 },
    motion: { heelDegrees: -8.4, pitchDegrees: 1.2 },
    extended: {
      rateOfTurnDegPerMin: 12.4,
      magneticVariationDeg: -14.5,
      trueWindAngleDegrees: 95,
      leewayDegrees: -1.2,
      current: { setDegrees: 150, driftKnots: 0.4 },
      transducerOffsetMeters: 0.6,
      depthBelowTransducerMeters: 12,
      airTemperatureC: 19,
      relativeHumidityPercent: 68,
      waveHeightMeters: 0.6,
      logTotalNm: 1234.5,
      logTripNm: 12.3,
      elapsedSeconds: 42,
    },
  }
}

export function fixedEncodeContext(channels = fixedChannels()): Omit<EncodeContext, 'settings'> {
  return { now: FIXED_TIME, state: fixedState(), channels }
}

export function testEncoder(): NmeaEncoder {
  return new NmeaEncoder(TEST_ENCODER_SETTINGS)
}

/** Encode one sentence and assert exactly one came out. */
export function encodeOne(id: Parameters<NmeaEncoder['encode']>[0], channels = fixedChannels()): string {
  const sentences = testEncoder().encode(id, fixedEncodeContext(channels))
  assert.equal(sentences.length, 1, `expected exactly one ${id} sentence, got ${sentences.length}`)
  return (sentences[0] as { text: string }).text
}

/** Split a sentence into its comma-separated fields (address excluded). */
export function fieldsOf(sentence: string): string[] {
  const parsed = parseSentence(sentence)
  assert.ok(parsed, `not a parseable sentence: ${JSON.stringify(sentence)}`)
  return parsed.fields
}

/**
 * The core wire-format contract, asserted for every sentence the simulator
 * produces: correct delimiter, valid checksum, CRLF termination, printable
 * ASCII only, and none of the tokens a broken number would leave behind.
 */
export function assertWellFormed(sentence: string): void {
  assert.ok(
    sentence.startsWith('$') || sentence.startsWith('!'),
    `sentence must start with $ or !: ${JSON.stringify(sentence)}`,
  )
  assert.ok(sentence.endsWith('\r\n'), `sentence must end with CRLF: ${JSON.stringify(sentence)}`)
  for (const token of ['NaN', 'undefined', 'null', 'Infinity']) {
    assert.ok(!sentence.includes(token), `sentence must not contain ${token}: ${sentence.trim()}`)
  }
  const parsed = parseSentence(sentence)
  assert.ok(parsed, `sentence must be parseable: ${JSON.stringify(sentence)}`)
  assert.equal(parsed.checksum, parsed.expectedChecksum, `checksum mismatch in ${sentence.trim()}`)
  assert.ok(parsed.valid, `checksum must be valid: ${sentence.trim()}`)
  assert.match(sentence.slice(0, -2), /^[\x20-\x7e]+$/, `sentence must be printable ASCII: ${sentence.trim()}`)
}

export interface TestEngine {
  engine: SimulatorEngine
  clock: ManualClock
  driver: ManualDriver
  /** Advance simulated time and run every task that falls due. */
  advance(milliseconds: number): void
  stop(): Promise<void>
}

export interface TestEngineOptions {
  env?: Record<string, string>
  argv?: string[]
  startEpochMs?: number
}

export function testConfig(options: TestEngineOptions = {}): SimulatorConfig {
  return loadConfig({
    argv: options.argv ?? ['--quiet'],
    env: {
      SIM_SEED: '12345',
      NMEA_PORT: '0',
      HTTP_ENABLED: 'false',
      QUIET: 'true',
      LOG_LEVEL: 'silent',
      ...options.env,
    },
    // Never let a developer's local `.env` change test results.
    envFileDir: null,
  })
}

/** Build an engine on a manual clock. Remember to `await stop()`. */
export async function createTestEngine(options: TestEngineOptions = {}): Promise<TestEngine> {
  const config = testConfig(options)
  const startEpochMs = options.startEpochMs ?? FIXED_TIME.getTime()
  const clock = new ManualClock(startEpochMs)
  const engine = new SimulatorEngine(config, { clock, logger: silentLogger })
  await engine.start()
  const driver = engine.simulationDriver as ManualDriver

  return {
    engine,
    clock,
    driver,
    advance: (milliseconds: number) => driver.advance(milliseconds),
    stop: () => engine.stop(),
  }
}

/** Collect every sentence a running engine emits while `body` runs. */
export function captureSentences(engine: SimulatorEngine): { lines: string[]; stop: () => void } {
  const lines: string[] = []
  const unsubscribe = engine.onSentence((emission) => lines.push(emission.text))
  return { lines, stop: unsubscribe }
}

/** Connect a TCP client and buffer everything it receives. */
export function connectClient(port: number, host = '127.0.0.1'): Promise<TcpTestClient> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host })
    let buffer = ''
    const lines: string[] = []

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\r\n')
      while (index >= 0) {
        lines.push(buffer.slice(0, index + 2))
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\r\n')
      }
    })
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.off('error', reject)
      socket.on('error', () => {})
      resolve({
        socket,
        lines,
        waitForLines: (count, timeoutMs = 5_000) => waitFor(() => lines.length >= count, timeoutMs, `${count} sentences`),
        close: () =>
          new Promise<void>((done) => {
            if (socket.destroyed) {
              done()
              return
            }
            socket.once('close', () => done())
            socket.destroy()
          }),
      })
    })
  })
}

export interface TcpTestClient {
  socket: net.Socket
  lines: string[]
  waitForLines(count: number, timeoutMs?: number): Promise<void>
  close(): Promise<void>
}

/** Poll until `predicate` holds, or fail with a useful message. */
export async function waitFor(predicate: () => boolean, timeoutMs = 5_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`)
}

/** A tiny JSON HTTP client, so the API tests need no dependencies. */
export async function requestJson(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const init: RequestInit = {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
  }
  if (body !== undefined) init.body = JSON.stringify(body)
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init)
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* leave as text so a failing assertion shows the raw response */
  }
  return { status: response.status, body: parsed }
}
