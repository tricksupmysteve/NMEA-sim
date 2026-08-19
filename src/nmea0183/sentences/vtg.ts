/**
 * VTG — Course Over Ground and Ground Speed.
 */

import { normalizeDegrees360 } from '../../core/math.js'
import { knotsToKilometresPerHour } from '../../core/units.js'
import { formatDegrees, formatNonNegative, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const vtg: SentenceDefinition = {
  id: 'VTG',
  requires: ['gps'],
  defaultTalker: 'GP',
  defaultHz: 1,
  description: 'Course over ground (true and magnetic) and ground speed (knots and km/h)',
  pgns: [129026],
  build({ channels, settings }) {
    const gps = channels.gps
    const sample = gps.value
    if (!gps.available || !sample) return []

    const valid = gps.valid && sample.fixQuality > 0
    const courseMagnetic = normalizeDegrees360(sample.cogDegrees - settings.magneticVariationDegrees)

    return [
      joinFields('VTG', [
        valid ? formatDegrees(sample.cogDegrees, 1) : '',
        'T',
        valid ? formatDegrees(courseMagnetic, 1) : '',
        'M',
        valid ? formatNonNegative(sample.sogKnots, 1) : '',
        'N',
        valid ? formatNonNegative(knotsToKilometresPerHour(sample.sogKnots), 1) : '',
        'K',
        valid ? 'A' : 'N',
      ]),
    ]
  },
}
