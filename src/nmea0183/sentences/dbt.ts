/**
 * DBT — Depth Below Transducer, in feet, metres and fathoms.
 */

import { metresToFathoms, metresToFeet } from '../../core/units.js'
import { formatNonNegative, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const dbt: SentenceDefinition = {
  id: 'DBT',
  requires: ['depth'],
  defaultTalker: 'SD',
  defaultHz: 1,
  description: 'Depth below the transducer in feet, metres and fathoms',
  pgns: [128267],
  build({ channels }) {
    const depth = channels.depth
    const sample = depth.value
    if (!depth.available || !sample || !depth.valid) return []
    const metres = Math.max(0, sample.depthBelowTransducerMeters)
    return [
      joinFields('DBT', [
        formatNonNegative(metresToFeet(metres), 1),
        'f',
        formatNonNegative(metres, 1),
        'M',
        formatNonNegative(metresToFathoms(metres), 1),
        'F',
      ]),
    ]
  },
}
