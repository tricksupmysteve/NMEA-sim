/**
 * Canonical simulator state.
 *
 * This is the single source of truth for the simulated vessel. Protocol
 * encoders (NMEA 0183 today, NMEA 2000 / Signal K / UDP later) are pure
 * functions of this state plus the instrument snapshots derived from it — they
 * never own or invent data of their own.
 *
 * Internal units are: degrees for angles, knots for speeds, metres for
 * distances, Celsius for temperature, hectopascals for pressure. Conversion
 * happens only at the encoding boundary.
 */

export interface BoatState {
  timestamp: Date

  position: {
    latitude: number
    longitude: number
    altitude?: number | undefined
    /** GGA fix quality: 0 = invalid, 1 = GPS, 2 = DGPS. */
    fixQuality: number
    satellites?: number | undefined
    hdop?: number | undefined
  }

  navigation: {
    headingTrue: number
    headingMagnetic?: number | undefined
    /** Course over ground, degrees true. */
    cog: number
    /** Speed over ground, knots. */
    sogKnots: number
    /** Speed through the water along the heading, knots. */
    speedThroughWaterKnots: number
  }

  wind: {
    /** Direction the true wind blows *from*, degrees true. */
    trueDirectionDegrees: number
    trueSpeedKnots: number
    /** Apparent wind angle relative to the bow, 0-360 clockwise. */
    apparentAngleDegrees: number
    apparentSpeedKnots: number
  }

  environment: {
    /** Depth of water below the surface, metres. */
    depthMeters: number
    waterTemperatureC: number
    airPressureHpa?: number | undefined
  }

  motion: {
    /** Positive to starboard. */
    heelDegrees?: number | undefined
    /** Positive bow-up. */
    pitchDegrees?: number | undefined
  }

  /**
   * Extensions beyond the minimum contract. These exist so that the NMEA 2000
   * PGN mappings in `docs`/README (127251 rate of turn, 130313 humidity,
   * 130314 pressure, …) have real data to bind to when that transport lands.
   */
  extended: {
    /** Rate of turn, degrees per minute; positive to starboard. */
    rateOfTurnDegPerMin: number
    /** Magnetic variation, degrees; positive east. */
    magneticVariationDeg: number
    /** True wind angle relative to the bow, 0-360 clockwise. */
    trueWindAngleDegrees: number
    /** Leeway angle, degrees; positive means slipping to starboard. */
    leewayDegrees: number
    /** Surface current, direction it sets *towards* (degrees true) and drift in knots. */
    current: {
      setDegrees: number
      driftKnots: number
    }
    /** Depth of the transducer below the waterline, metres. */
    transducerOffsetMeters: number
    /** Depth reading below the transducer, metres. */
    depthBelowTransducerMeters: number
    airTemperatureC: number
    relativeHumidityPercent: number
    /** Significant wave height, metres. */
    waveHeightMeters: number
    /** Cumulative distance through the water, nautical miles. */
    logTotalNm: number
    logTripNm: number
    /** Simulated seconds since the run started. */
    elapsedSeconds: number
  }
}

/** A deep-partial view used by `PATCH /state`. */
export type BoatStatePatch = {
  position?: Partial<Pick<BoatState['position'], 'latitude' | 'longitude' | 'altitude' | 'fixQuality' | 'satellites' | 'hdop'>>
  navigation?: Partial<Pick<BoatState['navigation'], 'headingTrue' | 'cog' | 'sogKnots' | 'speedThroughWaterKnots'>>
  wind?: Partial<Pick<BoatState['wind'], 'trueDirectionDegrees' | 'trueSpeedKnots'>>
  environment?: Partial<Pick<BoatState['environment'], 'depthMeters' | 'waterTemperatureC' | 'airPressureHpa'>>
  motion?: Partial<Pick<BoatState['motion'], 'heelDegrees' | 'pitchDegrees'>>
  current?: Partial<BoatState['extended']['current']>
}

/** The instruments the simulator models. Each is independently enable-able. */
export const INSTRUMENT_IDS = [
  'gps',
  'heading',
  'wind',
  'depth',
  'waterSpeed',
  'temperature',
  'pressure',
  'attitude',
  'ais',
] as const

export type InstrumentId = (typeof INSTRUMENT_IDS)[number]

export function isInstrumentId(value: string): value is InstrumentId {
  return (INSTRUMENT_IDS as readonly string[]).includes(value)
}
