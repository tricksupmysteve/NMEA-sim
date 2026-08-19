/**
 * Lying to an anchor.
 *
 * Speed over the ground is essentially zero, but nothing else is static: the
 * boat sails about its anchor so the heading swings through tens of degrees,
 * the GNSS receiver adds its own metre-scale wander, the wind keeps blowing,
 * and the depth changes only with the tide. Speed through the water reads the
 * current flowing past the hull, which is a good test that a consumer does not
 * conflate STW with SOG.
 */

import type { Random } from '../core/random.js'
import { environment, vessel } from './defaults.js'
import type { ScenarioDefinition, ScenarioInstance } from './types.js'

export const anchored: ScenarioDefinition = {
  name: 'anchored',
  label: 'Anchored',
  description:
    'At anchor: SOG near zero with GPS drift, heading swinging through the wind, active wind, stable depth on a slow tide.',
  highlights: ['SOG ~0 kn', 'heading swings ±25°', 'GPS drift only', 'wind still active', 'depth stable ~8 m'],
  create(random: Random): ScenarioInstance {
    void random
    return {
      setup: {
        vessel: vessel({
          propulsion: 'anchored',
          headingDegrees: 215,
          targetSpeedKnots: 0,
          speedSigmaKnots: 0.02,
          headingWanderSigmaDegrees: 3,
          heelStiffness: 140,
          maxHeelDegrees: 6,
          leewayCoefficient: 0,
          anchor: { rodeMeters: 45, swingSigmaDegrees: 22, swingTimeConstantSeconds: 90 },
        }),
        environment: environment({
          wind: { directionDegrees: 215, speedKnots: 9, gustKnots: 3, speedSigmaKnots: 1.1 },
          current: { setDegrees: 35, driftKnots: 0.45, driftSigmaKnots: 0.08 },
          seabed: {
            depthMeters: 8,
            // A boat at anchor stays over the same patch of seabed.
            depthVariationMeters: 0.4,
            featureScaleNm: 0.2,
            tideRangeMeters: 2.4,
          },
          waterTemperatureC: 15.8,
          fetchFactor: 0.25,
        }),
        nominalTrueWindSpeedKnots: 9,
        aisTargetCount: 2,
      },
    }
  },
}
