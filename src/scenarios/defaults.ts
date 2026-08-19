/**
 * Shared scenario building blocks.
 *
 * Every scenario starts from the same plausible coastal baseline and overrides
 * only what makes it distinctive, so the differences between scenarios are
 * legible rather than buried in five near-identical literals.
 */

import type { VesselSetup } from '../simulator/boat.js'
import type { EnvironmentSetup } from '../simulator/environment.js'

/**
 * Cape Cod Bay, Massachusetts. A real coastal position with sensible depths;
 * nothing in the simulator depends on it, and `PATCH /state` can move the boat
 * anywhere.
 */
export const DEFAULT_POSITION = { latitude: 41.95, longitude: -70.3 }

export const DEFAULT_VESSEL: VesselSetup = {
  propulsion: 'sail',
  position: DEFAULT_POSITION,
  headingDegrees: 145,
  targetSpeedKnots: 5.8,
  speedSigmaKnots: 0.18,
  speedTimeConstantSeconds: 25,
  headingWanderSigmaDegrees: 2.5,
  headingWanderTimeConstantSeconds: 12,
  turnRateDegPerSecond: 6,
  heelStiffness: 26,
  maxHeelDegrees: 28,
  leewayCoefficient: 9,
  hullSpeedKnots: 7.6,
  transducerOffsetMeters: 0.6,
  antennaHeightMeters: 2.4,
}

export const DEFAULT_ENVIRONMENT: EnvironmentSetup = {
  wind: {
    directionDegrees: 240,
    directionSigmaDegrees: 8,
    directionTimeConstantSeconds: 120,
    speedKnots: 14,
    speedSigmaKnots: 1.6,
    speedTimeConstantSeconds: 60,
    gustKnots: 4.5,
    gustIntervalSeconds: 45,
    gustDurationSeconds: 9,
  },
  current: {
    setDegrees: 150,
    driftKnots: 0.4,
    driftSigmaKnots: 0.12,
  },
  seabed: {
    depthMeters: 12,
    depthVariationMeters: 3.5,
    featureScaleNm: 0.35,
    tideRangeMeters: 1.2,
    // A semi-diurnal tide: 12 h 25 min.
    tidePeriodSeconds: 44_700,
  },
  waterTemperatureC: 16.5,
  waterTemperatureSigmaC: 0.35,
  airTemperatureC: 19,
  airPressureHpa: 1014,
  airPressureSigmaHpa: 2.5,
  relativeHumidityPercent: 68,
  fetchFactor: 0.8,
}

export function vessel(overrides: Partial<VesselSetup>): VesselSetup {
  return { ...DEFAULT_VESSEL, ...overrides }
}

export function environment(overrides: {
  wind?: Partial<EnvironmentSetup['wind']>
  current?: Partial<EnvironmentSetup['current']>
  seabed?: Partial<EnvironmentSetup['seabed']>
} & Partial<Omit<EnvironmentSetup, 'wind' | 'current' | 'seabed'>>): EnvironmentSetup {
  const { wind, current, seabed, ...rest } = overrides
  return {
    ...DEFAULT_ENVIRONMENT,
    ...rest,
    wind: { ...DEFAULT_ENVIRONMENT.wind, ...wind },
    current: { ...DEFAULT_ENVIRONMENT.current, ...current },
    seabed: { ...DEFAULT_ENVIRONMENT.seabed, ...seabed },
  }
}
