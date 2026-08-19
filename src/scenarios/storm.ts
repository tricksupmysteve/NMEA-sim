/**
 * Heavy weather.
 *
 * Gale-force wind with large gusts, a big sea, and a boat working hard: large
 * heading variation, large speed variation and heavy motion. The values are
 * severe but stay inside what a real vessel and real instruments would report
 * — nothing here is cartoonish, because the point is to stress a consumer's
 * handling of *plausible* extremes.
 */

import { normalizeDegrees360 } from '../core/math.js'
import type { Random } from '../core/random.js'
import { environment, vessel } from './defaults.js'
import type { ScenarioDefinition, ScenarioInstance } from './types.js'

export const storm: ScenarioDefinition = {
  name: 'storm',
  label: 'Storm',
  description:
    'Gale-force conditions: 38 kn mean true wind gusting into the 50s, a heavy sea, large heading and speed variation.',
  highlights: ['true wind ~38 kn', 'gusts to ~55 kn', 'large heading variation', 'heavy motion', 'depth ~45 m'],
  create(random: Random): ScenarioInstance {
    const rng = random.derive('storm')
    let secondsUntilCourseChange = rng.range(30, 90)

    return {
      setup: {
        vessel: vessel({
          propulsion: 'sail',
          headingDegrees: 200,
          targetSpeedKnots: 7.2,
          speedSigmaKnots: 1.1,
          speedTimeConstantSeconds: 12,
          headingWanderSigmaDegrees: 9,
          headingWanderTimeConstantSeconds: 7,
          turnRateDegPerSecond: 10,
          heelStiffness: 60,
          maxHeelDegrees: 34,
          leewayCoefficient: 16,
          hullSpeedKnots: 8.4,
        }),
        environment: environment({
          wind: {
            directionDegrees: 265,
            directionSigmaDegrees: 18,
            directionTimeConstantSeconds: 70,
            speedKnots: 38,
            speedSigmaKnots: 4.5,
            speedTimeConstantSeconds: 40,
            gustKnots: 15,
            gustIntervalSeconds: 25,
            gustDurationSeconds: 7,
          },
          current: { setDegrees: 190, driftKnots: 1.1, driftSigmaKnots: 0.3 },
          seabed: { depthMeters: 45, depthVariationMeters: 12, featureScaleNm: 1.2, tideRangeMeters: 1.6 },
          waterTemperatureC: 13.4,
          airTemperatureC: 12,
          airPressureHpa: 981,
          airPressureSigmaHpa: 4,
          relativeHumidityPercent: 92,
          fetchFactor: 1.7,
        }),
        nominalTrueWindSpeedKnots: 38,
        aisTargetCount: 1,
      },
      update(world, dtSeconds) {
        secondsUntilCourseChange -= dtSeconds
        if (secondsUntilCourseChange <= 0) {
          secondsUntilCourseChange = rng.range(30, 90)
          // Working the boat through the seas: bigger, more frequent helm input.
          world.vessel.steerTo(normalizeDegrees360(world.vessel.commandedHeading + rng.range(-25, 25)))
        }
      },
    }
  },
}
