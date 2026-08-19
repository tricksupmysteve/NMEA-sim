/**
 * DPT — Depth of Water.
 *
 * Field 1 is the depth below the transducer. Field 2 is the transducer offset:
 * positive means the distance from the transducer to the waterline (so
 * field1 + field2 = depth below the surface), negative means the distance to
 * the keel. The simulator configures a positive waterline offset.
 */

import { formatNonNegative, formatNumber, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const dpt: SentenceDefinition = {
  id: 'DPT',
  requires: ['depth'],
  defaultTalker: 'SD',
  defaultHz: 1,
  description: 'Water depth below the transducer plus the transducer offset',
  pgns: [128267],
  build({ channels }) {
    const depth = channels.depth
    const sample = depth.value
    if (!depth.available || !sample || !depth.valid) return []
    return [
      joinFields('DPT', [
        formatNonNegative(sample.depthBelowTransducerMeters, 1),
        formatNumber(sample.offsetMeters, 1),
        // Maximum range scale in use (NMEA 0183 v3.0 field); left empty.
        '',
      ]),
    ]
  },
}
