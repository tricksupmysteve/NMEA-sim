/**
 * Sailing under canvas on a coastal passage.
 *
 * Starting conditions: 6.1 kn over the ground, 5.8 kn through the water (the
 * difference is a fair current), heading 145°, 14 kn of true wind, 12 m of
 * water. The boat sails legs and then tacks or gybes through the wind, which
 * is what makes the apparent wind swap sides and the heel change direction.
 */

import { normalizeDegrees180, normalizeDegrees360 } from '../core/math.js'
import type { Random } from '../core/random.js'
import { environment, vessel } from './defaults.js'
import type { ScenarioDefinition, ScenarioInstance } from './types.js'

export const sailing: ScenarioDefinition = {
  name: 'sailing',
  label: 'Sailing',
  description:
    'Coastal sailing on a reach in 14 kn of true wind, with gusts, natural heading wander, heel, leeway and periodic tacks.',
  highlights: ['SOG ~6.1 kn', 'STW ~5.8 kn', 'heading 145°', 'true wind 14 kn from 240°', 'depth ~12 m'],
  create(random: Random): ScenarioInstance {
    const rng = random.derive('sailing')
    let secondsUntilManoeuvre = rng.range(240, 420)
    let secondsUntilTrim = rng.range(25, 60)

    return {
      setup: {
        vessel: vessel({ propulsion: 'sail', headingDegrees: 145, targetSpeedKnots: 5.8 }),
        environment: environment({}),
        nominalTrueWindSpeedKnots: 14,
        aisTargetCount: 3,
      },
      update(world, dtSeconds) {
        const state = world.boatState
        secondsUntilManoeuvre -= dtSeconds
        secondsUntilTrim -= dtSeconds

        if (secondsUntilManoeuvre <= 0) {
          secondsUntilManoeuvre = rng.range(240, 420)
          // Tack or gybe: mirror the true wind angle to the other side.
          const trueWindAngle = normalizeDegrees180(
            state.wind.trueDirectionDegrees - world.vessel.commandedHeading,
          )
          world.vessel.steerTo(normalizeDegrees360(state.wind.trueDirectionDegrees + trueWindAngle))
          return
        }

        if (secondsUntilTrim <= 0) {
          secondsUntilTrim = rng.range(25, 60)
          // Small helm corrections between manoeuvres, as a helmsman would make.
          world.vessel.steerTo(normalizeDegrees360(world.vessel.commandedHeading + rng.range(-4, 4)))
        }
      },
    }
  },
}
