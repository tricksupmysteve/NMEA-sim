/**
 * Request validation for the control API.
 *
 * Every value that can reach the simulation goes through here first. The
 * simulator's whole purpose is to emit *valid* NMEA, so an API that let a
 * caller push `NaN` into the wind speed would defeat the point. Validators
 * return a list of problems rather than throwing on the first one, so a caller
 * gets everything wrong with their request in a single response.
 */

import { isSentenceId, type SentenceId } from '../nmea0183/types.js'
import { isChannelFault, type ChannelFault } from '../simulator/instruments.js'
import type { FaultAction } from '../simulator/faults.js'
import { isInstrumentId, type BoatStatePatch, type InstrumentId } from '../types.js'

export interface ValidationResult<T> {
  ok: boolean
  value: T | null
  problems: string[]
}

function fail<T>(problems: string[]): ValidationResult<T> {
  return { ok: false, value: null, problems }
}

function succeed<T>(value: T): ValidationResult<T> {
  return { ok: true, value, problems: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A finite number inside an inclusive range, or a problem describing why not. */
function checkNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
  problems: string[],
): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.push(`${path} must be a finite number`)
    return undefined
  }
  if (value < min || value > max) {
    problems.push(`${path} must be between ${min} and ${max}`)
    return undefined
  }
  return value
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, problems: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      problems.push(`${path}.${key} is not a recognised field (allowed: ${allowed.join(', ')})`)
    }
  }
}

const POSITION_KEYS = ['latitude', 'longitude', 'altitude', 'fixQuality', 'satellites', 'hdop'] as const
const NAVIGATION_KEYS = ['headingTrue', 'cog', 'sogKnots', 'speedThroughWaterKnots'] as const
const WIND_KEYS = ['trueDirectionDegrees', 'trueSpeedKnots'] as const
const ENVIRONMENT_KEYS = ['depthMeters', 'waterTemperatureC', 'airPressureHpa'] as const
const MOTION_KEYS = ['heelDegrees', 'pitchDegrees'] as const
const CURRENT_KEYS = ['setDegrees', 'driftKnots'] as const
const PATCH_KEYS = ['position', 'navigation', 'wind', 'environment', 'motion', 'current'] as const

/** Validate the body of `PATCH /state`. */
export function validateStatePatch(body: unknown): ValidationResult<BoatStatePatch> {
  if (!isRecord(body)) return fail(['Request body must be a JSON object'])

  const problems: string[] = []
  rejectUnknownKeys(body, PATCH_KEYS, 'body', problems)

  const patch: BoatStatePatch = {}

  if (body['position'] !== undefined) {
    if (!isRecord(body['position'])) {
      problems.push('position must be an object')
    } else {
      const source = body['position']
      rejectUnknownKeys(source, POSITION_KEYS, 'position', problems)
      const position: NonNullable<BoatStatePatch['position']> = {}
      assign(position, 'latitude', checkNumber(source['latitude'], 'position.latitude', -90, 90, problems))
      assign(position, 'longitude', checkNumber(source['longitude'], 'position.longitude', -180, 180, problems))
      assign(position, 'altitude', checkNumber(source['altitude'], 'position.altitude', -500, 10_000, problems))
      assign(position, 'fixQuality', checkNumber(source['fixQuality'], 'position.fixQuality', 0, 8, problems))
      assign(position, 'satellites', checkNumber(source['satellites'], 'position.satellites', 0, 64, problems))
      assign(position, 'hdop', checkNumber(source['hdop'], 'position.hdop', 0.1, 50, problems))
      if (Object.keys(position).length > 0) patch.position = position
    }
  }

  if (body['navigation'] !== undefined) {
    if (!isRecord(body['navigation'])) {
      problems.push('navigation must be an object')
    } else {
      const source = body['navigation']
      rejectUnknownKeys(source, NAVIGATION_KEYS, 'navigation', problems)
      const navigation: NonNullable<BoatStatePatch['navigation']> = {}
      assign(navigation, 'headingTrue', checkNumber(source['headingTrue'], 'navigation.headingTrue', 0, 360, problems))
      assign(navigation, 'cog', checkNumber(source['cog'], 'navigation.cog', 0, 360, problems))
      assign(navigation, 'sogKnots', checkNumber(source['sogKnots'], 'navigation.sogKnots', 0, 80, problems))
      assign(
        navigation,
        'speedThroughWaterKnots',
        checkNumber(source['speedThroughWaterKnots'], 'navigation.speedThroughWaterKnots', 0, 80, problems),
      )
      if (Object.keys(navigation).length > 0) patch.navigation = navigation
    }
  }

  if (body['wind'] !== undefined) {
    if (!isRecord(body['wind'])) {
      problems.push('wind must be an object')
    } else {
      const source = body['wind']
      rejectUnknownKeys(source, WIND_KEYS, 'wind', problems)
      const wind: NonNullable<BoatStatePatch['wind']> = {}
      assign(
        wind,
        'trueDirectionDegrees',
        checkNumber(source['trueDirectionDegrees'], 'wind.trueDirectionDegrees', 0, 360, problems),
      )
      // 150 kn is well above any recorded surface wind; it is a sanity bound,
      // not a claim that the simulator produces such conditions.
      assign(wind, 'trueSpeedKnots', checkNumber(source['trueSpeedKnots'], 'wind.trueSpeedKnots', 0, 150, problems))
      if (Object.keys(wind).length > 0) patch.wind = wind
    }
  }

  if (body['environment'] !== undefined) {
    if (!isRecord(body['environment'])) {
      problems.push('environment must be an object')
    } else {
      const source = body['environment']
      rejectUnknownKeys(source, ENVIRONMENT_KEYS, 'environment', problems)
      const environment: NonNullable<BoatStatePatch['environment']> = {}
      assign(environment, 'depthMeters', checkNumber(source['depthMeters'], 'environment.depthMeters', 0.2, 12_000, problems))
      assign(
        environment,
        'waterTemperatureC',
        checkNumber(source['waterTemperatureC'], 'environment.waterTemperatureC', -2, 40, problems),
      )
      assign(
        environment,
        'airPressureHpa',
        checkNumber(source['airPressureHpa'], 'environment.airPressureHpa', 850, 1100, problems),
      )
      if (Object.keys(environment).length > 0) patch.environment = environment
    }
  }

  if (body['motion'] !== undefined) {
    if (!isRecord(body['motion'])) {
      problems.push('motion must be an object')
    } else {
      const source = body['motion']
      rejectUnknownKeys(source, MOTION_KEYS, 'motion', problems)
      const motion: NonNullable<BoatStatePatch['motion']> = {}
      assign(motion, 'heelDegrees', checkNumber(source['heelDegrees'], 'motion.heelDegrees', -80, 80, problems))
      assign(motion, 'pitchDegrees', checkNumber(source['pitchDegrees'], 'motion.pitchDegrees', -45, 45, problems))
      if (Object.keys(motion).length > 0) patch.motion = motion
    }
  }

  if (body['current'] !== undefined) {
    if (!isRecord(body['current'])) {
      problems.push('current must be an object')
    } else {
      const source = body['current']
      rejectUnknownKeys(source, CURRENT_KEYS, 'current', problems)
      const current: NonNullable<BoatStatePatch['current']> = {}
      assign(current, 'setDegrees', checkNumber(source['setDegrees'], 'current.setDegrees', 0, 360, problems))
      assign(current, 'driftKnots', checkNumber(source['driftKnots'], 'current.driftKnots', 0, 12, problems))
      if (Object.keys(current).length > 0) patch.current = current
    }
  }

  if (problems.length > 0) return fail(problems)
  if (Object.keys(patch).length === 0) return fail(['Request body contained nothing to change'])
  return succeed(patch)
}

export interface InstrumentUpdate {
  instrument: InstrumentId
  enabled?: boolean | undefined
  fault?: ChannelFault | undefined
}

/** Validate `POST /instruments/:id`. */
export function validateInstrumentUpdate(instrument: string, body: unknown): ValidationResult<InstrumentUpdate> {
  const problems: string[] = []
  if (!isInstrumentId(instrument)) {
    return fail([`Unknown instrument "${instrument}"`])
  }
  if (body !== undefined && !isRecord(body)) {
    return fail(['Request body must be a JSON object'])
  }

  const source = isRecord(body) ? body : {}
  rejectUnknownKeys(source, ['enabled', 'fault'], 'body', problems)

  let enabled: boolean | undefined
  if (source['enabled'] !== undefined) {
    if (typeof source['enabled'] !== 'boolean') {
      problems.push('enabled must be a boolean')
    } else {
      enabled = source['enabled']
    }
  }

  let fault: ChannelFault | undefined
  if (source['fault'] !== undefined) {
    if (typeof source['fault'] !== 'string' || !isChannelFault(source['fault'])) {
      problems.push('fault must be one of: none, frozen, offline, invalid')
    } else {
      fault = source['fault']
    }
  }

  if (problems.length > 0) return fail(problems)
  if (enabled === undefined && fault === undefined) {
    return fail(['Provide "enabled" and/or "fault"'])
  }

  const update: InstrumentUpdate = { instrument }
  if (enabled !== undefined) update.enabled = enabled
  if (fault !== undefined) update.fault = fault
  return succeed(update)
}

/** Validate `POST /faults`. */
export function validateFaultAction(body: unknown): ValidationResult<FaultAction> {
  if (!isRecord(body)) return fail(['Request body must be a JSON object'])
  const problems: string[] = []
  const type = body['type']

  if (type === 'instrument') {
    rejectUnknownKeys(body, ['type', 'instrument', 'fault'], 'body', problems)
    const instrument = body['instrument']
    const fault = body['fault']
    if (typeof instrument !== 'string' || !isInstrumentId(instrument)) problems.push('instrument is not recognised')
    if (typeof fault !== 'string' || !isChannelFault(fault)) {
      problems.push('fault must be one of: none, frozen, offline, invalid')
    }
    if (problems.length > 0) return fail(problems)
    return succeed({ type: 'instrument', instrument: instrument as InstrumentId, fault: fault as ChannelFault })
  }

  if (type === 'badChecksum' || type === 'malformed') {
    rejectUnknownKeys(body, ['type', 'count', 'probability', 'durationSeconds'], 'body', problems)
    const count = checkNumber(body['count'], 'count', 0, 10_000, problems)
    const probability = checkNumber(body['probability'], 'probability', 0, 1, problems)
    const durationSeconds = checkNumber(body['durationSeconds'], 'durationSeconds', 0, 86_400, problems)
    if (count === undefined && probability === undefined) {
      problems.push('Provide "count" and/or "probability"')
    }
    if (problems.length > 0) return fail(problems)
    const action: Extract<FaultAction, { type: 'badChecksum' | 'malformed' }> = { type }
    if (count !== undefined) action.count = Math.round(count)
    if (probability !== undefined) action.probability = probability
    if (durationSeconds !== undefined) action.durationSeconds = durationSeconds
    return succeed(action)
  }

  if (type === 'clearAll' || type === 'clearWireFaults') {
    rejectUnknownKeys(body, ['type'], 'body', problems)
    if (problems.length > 0) return fail(problems)
    return succeed({ type })
  }

  return fail(['type must be one of: instrument, badChecksum, malformed, clearWireFaults, clearAll'])
}

export interface SentenceRateUpdate {
  id: SentenceId
  hz: number
}

/** Validate `POST /sentences/:id/rate`. */
export function validateSentenceRate(id: string, body: unknown): ValidationResult<SentenceRateUpdate> {
  const upper = id.toUpperCase()
  if (!isSentenceId(upper)) return fail([`Unknown sentence "${id}"`])
  if (!isRecord(body)) return fail(['Request body must be a JSON object'])

  const problems: string[] = []
  rejectUnknownKeys(body, ['hz'], 'body', problems)
  const hz = checkNumber(body['hz'], 'hz', 0, 100, problems)
  if (hz === undefined && problems.length === 0) problems.push('hz is required')
  if (problems.length > 0) return fail(problems)

  return succeed({ id: upper, hz: hz as number })
}

/**
 * `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
 * property, so optional fields are only written when they actually have a value.
 */
function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value
}
