/**
 * Configuration.
 *
 * Precedence, lowest to highest: built-in defaults, then `.env`, then the real
 * environment, then command-line flags. Everything is validated up front and
 * bad input is reported as a list of problems rather than crashing later with a
 * `NaN` somewhere in a sentence.
 */

import fs from 'node:fs'
import path from 'node:path'
import { PROFILES, isProfileName, type ProfileName } from './nmea0183/profiles.js'
import { SENTENCE_IDS, isSentenceId, type SentenceId } from './nmea0183/types.js'
import { isScenarioName, type ScenarioName } from './scenarios/types.js'
import { INSTRUMENT_IDS, isInstrumentId, type InstrumentId } from './types.js'
import type { InstrumentIntervals, InstrumentToggles } from './simulator/instruments.js'
import type { OwnShipIdentity } from './simulator/world.js'

export interface SimulatorConfig {
  nodeEnv: string

  /** The raw NMEA 0183 TCP stream — this is what Matey connects to. */
  nmea: {
    host: string
    port: number
    maxClients: number
    highWaterMarkBytes: number
    hardLimitBytes: number
  }

  /** The HTTP control API. Separate from, and optional to, the NMEA stream. */
  http: {
    enabled: boolean
    host: string
    port: number
    /** When set, every request must present `Authorization: Bearer <token>`. */
    token: string | null
    corsOrigin: string
  }

  /** Optional UDP output; off unless explicitly enabled. */
  udp: {
    enabled: boolean
    host: string
    port: number
    broadcast: boolean
  }

  scenario: ScenarioName
  profile: ProfileName
  seed: number

  /** Per-sentence transmission rates in hertz, resolved from the profile. */
  sentenceRatesHz: Record<string, number>

  /** How often the physics integrates, in hertz. */
  physicsHz: number

  instrumentEnabled: InstrumentToggles
  instrumentIntervalsMs: InstrumentIntervals

  magneticVariationDegrees: number
  compassDeviationDegrees: number
  gnssAccuracyMeters: number
  coordinateDecimals: number
  timeDecimals: number

  ownShip: OwnShipIdentity

  /** Multiplier on the passage of simulated time. 1 = real time. */
  timeScale: number
  /** Fixed UTC start instant; when null the process start time is used. */
  startEpochMs: number | null

  logNmea: boolean
  logLevel: LogLevel
  /** Milliseconds between console status refreshes; 0 disables the dashboard. */
  statusIntervalMs: number
  /** Suppress the banner and dashboard entirely (used by tests). */
  quiet: boolean
}

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug'

const LOG_LEVELS: readonly LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug']

/** Sensor sampling rates. These are deliberately not the sentence rates. */
const DEFAULT_INSTRUMENT_INTERVALS_MS: InstrumentIntervals = {
  gps: 250,
  heading: 100,
  wind: 200,
  depth: 500,
  waterSpeed: 250,
  temperature: 2_000,
  pressure: 5_000,
  attitude: 100,
  ais: 5_000,
}

export const DEFAULT_NMEA_PORT = 39150
export const DEFAULT_HTTP_PORT = 3000

class ConfigErrors {
  readonly problems: string[] = []

  add(problem: string): void {
    this.problems.push(problem)
  }

  throwIfAny(): void {
    if (this.problems.length === 0) return
    throw new ConfigError(this.problems)
  }
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
  }
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv
  argv?: string[]
  /** Directory to look in for a `.env` file. Pass null to skip loading one. */
  envFileDir?: string | null
}

/**
 * Read a `.env` file into a plain object.
 *
 * Deliberately minimal: `KEY=value` lines, `#` comments, optional surrounding
 * quotes. Values already present in the real environment always win.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    if (key.length > 0) values[key] = value
  }
  return values
}

export function loadConfig(options: LoadConfigOptions = {}): SimulatorConfig {
  const processEnv = options.env ?? process.env
  const argv = options.argv ?? process.argv.slice(2)
  const errors = new ConfigErrors()

  const env: Record<string, string | undefined> = { ...readEnvFile(options.envFileDir), ...processEnv }
  const cli = parseArgs(argv, errors)

  const scenario = pickScenario(cli['scenario'] ?? env['SIM_SCENARIO'], errors)
  const profile = pickProfile(cli['profile'] ?? env['NMEA_PROFILE'], errors)

  const config: SimulatorConfig = {
    nodeEnv: env['NODE_ENV'] ?? 'development',

    nmea: {
      host: cli['host'] ?? env['NMEA_HOST'] ?? '0.0.0.0',
      port: integer(cli['port'] ?? env['NMEA_PORT'], DEFAULT_NMEA_PORT, 'NMEA_PORT', errors, 0, 65_535),
      maxClients: integer(env['NMEA_MAX_CLIENTS'], 64, 'NMEA_MAX_CLIENTS', errors, 1, 10_000),
      highWaterMarkBytes: integer(env['NMEA_CLIENT_HIGH_WATER_BYTES'], 256 * 1024, 'NMEA_CLIENT_HIGH_WATER_BYTES', errors, 1024, 64 * 1024 * 1024),
      hardLimitBytes: integer(env['NMEA_CLIENT_HARD_LIMIT_BYTES'], 2 * 1024 * 1024, 'NMEA_CLIENT_HARD_LIMIT_BYTES', errors, 4096, 256 * 1024 * 1024),
    },

    http: {
      enabled: !cli['no-http'] && boolean(env['HTTP_ENABLED'], true, 'HTTP_ENABLED', errors),
      host: env['HTTP_HOST'] ?? '0.0.0.0',
      // Railway injects PORT for the HTTP service; honour it.
      port: integer(cli['http-port'] ?? env['PORT'] ?? env['HTTP_PORT'], DEFAULT_HTTP_PORT, 'PORT', errors, 0, 65_535),
      token: nonEmpty(env['API_TOKEN']),
      corsOrigin: env['CORS_ORIGIN'] ?? '*',
    },

    udp: {
      enabled: boolean(cli['udp'] ?? env['UDP_ENABLED'], false, 'UDP_ENABLED', errors),
      host: env['UDP_HOST'] ?? '255.255.255.255',
      port: integer(env['UDP_PORT'], 10110, 'UDP_PORT', errors, 1, 65_535),
      broadcast: boolean(env['UDP_BROADCAST'], true, 'UDP_BROADCAST', errors),
    },

    scenario,
    profile,
    seed: integer(cli['seed'] ?? env['SIM_SEED'], 12_345, 'SIM_SEED', errors, 0, 0xffffffff),

    sentenceRatesHz: resolveSentenceRates(profile, env, cli, errors),

    physicsHz: number(env['SIM_PHYSICS_HZ'], 20, 'SIM_PHYSICS_HZ', errors, 1, 200),

    instrumentEnabled: resolveInstrumentToggles(env, cli, errors),
    instrumentIntervalsMs: resolveInstrumentIntervals(env, errors),

    magneticVariationDegrees: number(env['MAGNETIC_VARIATION_DEG'], -14.5, 'MAGNETIC_VARIATION_DEG', errors, -180, 180),
    compassDeviationDegrees: number(env['COMPASS_DEVIATION_DEG'], 0.5, 'COMPASS_DEVIATION_DEG', errors, -45, 45),
    gnssAccuracyMeters: number(env['GNSS_ACCURACY_M'], 2.5, 'GNSS_ACCURACY_M', errors, 0, 200),
    coordinateDecimals: integer(env['NMEA_COORDINATE_DECIMALS'], 4, 'NMEA_COORDINATE_DECIMALS', errors, 2, 6),
    timeDecimals: integer(env['NMEA_TIME_DECIMALS'], 2, 'NMEA_TIME_DECIMALS', errors, 0, 3),

    ownShip: {
      mmsi: integer(env['OWN_SHIP_MMSI'], 366123456, 'OWN_SHIP_MMSI', errors, 1, 999_999_999),
      name: (env['OWN_SHIP_NAME'] ?? 'MATEY SIM').slice(0, 20),
      callSign: (env['OWN_SHIP_CALLSIGN'] ?? 'MTY1').slice(0, 7),
      shipType: integer(env['OWN_SHIP_TYPE'], 36, 'OWN_SHIP_TYPE', errors, 0, 99),
    },

    timeScale: number(cli['time-scale'] ?? env['SIM_TIME_SCALE'], 1, 'SIM_TIME_SCALE', errors, 0.01, 100),
    startEpochMs: parseStartTime(env['SIM_START_TIME'], errors),

    logNmea: Boolean(cli['verbose']) || boolean(env['LOG_NMEA'], false, 'LOG_NMEA', errors),
    logLevel: pickLogLevel(env['LOG_LEVEL'], errors),
    statusIntervalMs: integer(env['STATUS_INTERVAL_MS'], 5_000, 'STATUS_INTERVAL_MS', errors, 0, 600_000),
    quiet: Boolean(cli['quiet']) || boolean(env['QUIET'], false, 'QUIET', errors),
  }

  errors.throwIfAny()
  return config
}

function readEnvFile(directory: string | null | undefined): Record<string, string> {
  if (directory === null) return {}
  const file = path.join(directory ?? process.cwd(), '.env')
  try {
    if (!fs.existsSync(file)) return {}
    return parseEnvFile(fs.readFileSync(file, 'utf8'))
  } catch {
    // A `.env` that cannot be read is not fatal; the environment still applies.
    return {}
  }
}

/** Flags are `--name value`, `--name=value` or a bare boolean `--name`. */
export function parseArgs(argv: readonly string[], errors: ConfigErrors): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {}
  const aliases: Record<string, string> = { s: 'scenario', p: 'port', v: 'verbose', h: 'help' }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue
    if (!argument.startsWith('-')) {
      errors.add(`Unexpected argument "${argument}"`)
      continue
    }

    const stripped = argument.replace(/^--?/, '')
    const [rawName = '', inlineValue] = splitOnce(stripped, '=')
    const name = aliases[rawName] ?? rawName

    if (inlineValue !== undefined) {
      values[name] = inlineValue
      continue
    }

    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('-')) {
      values[name] = next
      index += 1
    } else {
      values[name] = 'true'
    }
  }

  return values
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
  const index = value.indexOf(separator)
  if (index < 0) return [value, undefined]
  return [value.slice(0, index), value.slice(index + 1)]
}

function pickScenario(value: string | undefined, errors: ConfigErrors): ScenarioName {
  if (value === undefined || value === '') return 'sailing'
  const normalised = value.trim().toLowerCase()
  if (isScenarioName(normalised)) return normalised
  // Tolerate the camelCase filename spelling as well as the kebab-case name.
  if (normalised === 'sensorfailure') return 'sensor-failure'
  errors.add(`Unknown scenario "${value}"`)
  return 'sailing'
}

function pickProfile(value: string | undefined, errors: ConfigErrors): ProfileName {
  if (value === undefined || value === '') return 'garmin-wifi'
  const normalised = value.trim().toLowerCase()
  if (isProfileName(normalised)) return normalised
  errors.add(`Unknown profile "${value}". Available: ${Object.keys(PROFILES).join(', ')}`)
  return 'garmin-wifi'
}

function pickLogLevel(value: string | undefined, errors: ConfigErrors): LogLevel {
  if (value === undefined || value === '') return 'info'
  const normalised = value.trim().toLowerCase() as LogLevel
  if (LOG_LEVELS.includes(normalised)) return normalised
  errors.add(`Unknown LOG_LEVEL "${value}". Available: ${LOG_LEVELS.join(', ')}`)
  return 'info'
}

/**
 * Sentence rates come from the profile, and any `NMEA_RATE_<ID>` variable
 * overrides one of them. Setting a rate to 0 removes the sentence.
 */
function resolveSentenceRates(
  profile: ProfileName,
  env: Record<string, string | undefined>,
  cli: Record<string, string | undefined>,
  errors: ConfigErrors,
): Record<string, number> {
  const rates: Record<string, number> = {}
  for (const entry of PROFILES[profile].sentences) {
    rates[entry.id] = entry.hz
  }

  for (const id of SENTENCE_IDS) {
    const key = `NMEA_RATE_${id}`
    const raw = cli[`rate-${id.toLowerCase()}`] ?? env[key]
    if (raw === undefined) continue
    const hz = number(raw, rates[id] ?? 0, key, errors, 0, 100)
    if (hz <= 0) {
      delete rates[id]
    } else {
      rates[id] = hz
    }
  }

  // Allow adding a sentence that is not in the profile, e.g. NMEA_RATE_ZDA=1.
  for (const key of Object.keys(env)) {
    if (!key.startsWith('NMEA_RATE_')) continue
    const id = key.slice('NMEA_RATE_'.length)
    if (!isSentenceId(id)) errors.add(`Unknown sentence in ${key}; expected one of ${SENTENCE_IDS.join(', ')}`)
  }

  return rates
}

function resolveInstrumentToggles(
  env: Record<string, string | undefined>,
  cli: Record<string, string | undefined>,
  errors: ConfigErrors,
): InstrumentToggles {
  const defaults: InstrumentToggles = {
    gps: true,
    heading: true,
    wind: true,
    depth: true,
    waterSpeed: true,
    temperature: true,
    pressure: true,
    attitude: true,
    // AIS is optional and off by default; nothing depends on it.
    ais: false,
  }

  const envKeys: Record<InstrumentId, string> = {
    gps: 'ENABLE_GPS',
    heading: 'ENABLE_HEADING',
    wind: 'ENABLE_WIND',
    depth: 'ENABLE_DEPTH',
    waterSpeed: 'ENABLE_WATER_SPEED',
    temperature: 'ENABLE_TEMPERATURE',
    pressure: 'ENABLE_PRESSURE',
    attitude: 'ENABLE_ATTITUDE',
    ais: 'ENABLE_AIS',
  }

  const toggles = { ...defaults }
  for (const id of INSTRUMENT_IDS) {
    const key = envKeys[id]
    toggles[id] = boolean(env[key], defaults[id], key, errors)
  }

  // `--disable wind,depth` / `--enable ais`
  for (const [flag, value] of [
    ['disable', false],
    ['enable', true],
  ] as const) {
    const raw = cli[flag]
    if (raw === undefined || raw === 'true') continue
    for (const name of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
      if (isInstrumentId(name)) {
        toggles[name] = value
      } else {
        errors.add(`Unknown instrument "${name}" in --${flag}; expected one of ${INSTRUMENT_IDS.join(', ')}`)
      }
    }
  }

  return toggles
}

function resolveInstrumentIntervals(
  env: Record<string, string | undefined>,
  errors: ConfigErrors,
): InstrumentIntervals {
  const intervals = { ...DEFAULT_INSTRUMENT_INTERVALS_MS }
  for (const id of INSTRUMENT_IDS) {
    const key = `SENSOR_INTERVAL_${id.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_MS`
    const raw = env[key]
    if (raw === undefined) continue
    intervals[id] = integer(raw, intervals[id], key, errors, 10, 600_000)
  }
  return intervals
}

function parseStartTime(value: string | undefined, errors: ConfigErrors): number | null {
  if (value === undefined || value === '') return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
    errors.add(`SIM_START_TIME "${value}" is not a valid ISO-8601 timestamp`)
    return null
  }
  return parsed
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim()
}

function number(
  value: string | number | undefined,
  fallback: number,
  name: string,
  errors: ConfigErrors,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    errors.add(`${name} must be a number, got "${String(value)}"`)
    return fallback
  }
  if (parsed < min || parsed > max) {
    errors.add(`${name} must be between ${min} and ${max}, got ${parsed}`)
    return fallback
  }
  return parsed
}

function integer(
  value: string | number | undefined,
  fallback: number,
  name: string,
  errors: ConfigErrors,
  min: number,
  max: number,
): number {
  const parsed = number(value, fallback, name, errors, min, max)
  return Math.round(parsed)
}

function boolean(value: string | boolean | undefined, fallback: boolean, name: string, errors: ConfigErrors): boolean {
  if (value === undefined || value === '') return fallback
  if (typeof value === 'boolean') return value
  const normalised = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalised)) return true
  if (['0', 'false', 'no', 'off'].includes(normalised)) return false
  errors.add(`${name} must be a boolean (true/false), got "${value}"`)
  return fallback
}

/** Sentence ids present in the resolved rate table, in registry order. */
export function activeSentenceIds(config: SimulatorConfig): SentenceId[] {
  return SENTENCE_IDS.filter((id) => (config.sentenceRatesHz[id] ?? 0) > 0)
}
