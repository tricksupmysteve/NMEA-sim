/**
 * Motoring at cruising speed.
 *
 * A powered vessel making 18-25 kn with small heading variations and very
 * little heel. Speed through the water is commanded directly rather than
 * derived from a sailing polar, so the wind moves the apparent wind but not
 * the boat.
 */

import { normalizeDegrees360 } from '../core/math.js'
import type { Random } from '../core/random.js'
import { environment, vessel } from './defaults.js'
import type { ScenarioDefinition, ScenarioInstance } from './types.js'

export const cruising: ScenarioDefinition = {
  name: 'cruising',
  label: 'Cruising',
  description:
    'Powered cruising at 18-25 kn with gentle course changes, minimal heel and deeper water.',
  highlights: ['SOG 18-25 kn', 'heading ~90°', 'small heading variation', 'limited heel', 'depth ~26 m'],
  create(random: Random): ScenarioInstance {
    const rng = random.derive('cruising')
    let secondsUntilCourseChange = rng.range(90, 210)
    let secondsUntilThrottle = rng.range(60, 150)

    return {
      setup: {
        vessel: vessel({
          propulsion: 'motor',
          headingDegrees: 90,
          targetSpeedKnots: 21,
          speedSigmaKnots: 0.35,
          speedTimeConstantSeconds: 18,
          headingWanderSigmaDegrees: 1.2,
          headingWanderTimeConstantSeconds: 9,
          turnRateDegPerSecond: 8,
          heelStiffness: 90,
          maxHeelDegrees: 8,
          leewayCoefficient: 0,
          hullSpeedKnots: 28,
        }),
        environment: environment({
          wind: { directionDegrees: 200, speedKnots: 11, gustKnots: 3.5 },
          current: { setDegrees: 60, driftKnots: 0.6 },
          seabed: { depthMeters: 26, depthVariationMeters: 6, featureScaleNm: 0.8 },
          waterTemperatureC: 17.2,
        }),
        nominalTrueWindSpeedKnots: 11,
        aisTargetCount: 4,
      },
      update(world, dtSeconds) {
        secondsUntilCourseChange -= dtSeconds
        secondsUntilThrottle -= dtSeconds

        if (secondsUntilCourseChange <= 0) {
          secondsUntilCourseChange = rng.range(90, 210)
          world.vessel.steerTo(normalizeDegrees360(world.vessel.commandedHeading + rng.range(-12, 12)))
        }

        if (secondsUntilThrottle <= 0) {
          secondsUntilThrottle = rng.range(60, 150)
          // Stay inside the 18-25 kn band the scenario advertises.
          world.vessel.setTargetSpeed(rng.range(18, 25))
        }
      },
    }
  },
}
