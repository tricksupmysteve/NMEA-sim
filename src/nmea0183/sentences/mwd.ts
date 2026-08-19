/**
 * MWD — Wind Direction and Speed.
 *
 * The true wind as a *compass direction* (the direction it blows from),
 * independent of where the bow happens to be pointing. This is a third,
 * distinct quantity from MWV's relative and true-relative angles.
 */

import { normalizeDegrees360 } from '../../core/math.js'
import { knotsToMetresPerSecond } from '../../core/units.js'
import { formatDegrees, formatNonNegative, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const mwd: SentenceDefinition = {
  id: 'MWD',
  requires: ['wind'],
  defaultTalker: 'WI',
  defaultHz: 1,
  description: 'True wind direction (true and magnetic) and speed (knots and m/s)',
  pgns: [130306],
  build({ channels, settings }) {
    const wind = channels.wind
    const sample = wind.value
    if (!wind.available || !sample || !wind.valid) return []

    const magneticDirection = normalizeDegrees360(sample.trueDirectionDegrees - settings.magneticVariationDegrees)

    return [
      joinFields('MWD', [
        formatDegrees(sample.trueDirectionDegrees, 1),
        'T',
        formatDegrees(magneticDirection, 1),
        'M',
        formatNonNegative(sample.trueSpeedKnots, 1),
        'N',
        formatNonNegative(knotsToMetresPerSecond(sample.trueSpeedKnots), 1),
        'M',
      ]),
    ]
  },
}
