/**
 * ROT — Rate of Turn. Negative values are to port.
 */

import { formatNumber, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const rot: SentenceDefinition = {
  id: 'ROT',
  requires: ['heading'],
  defaultTalker: 'II',
  defaultHz: 1,
  description: 'Rate of turn in degrees per minute',
  pgns: [127251],
  build({ channels }) {
    const heading = channels.heading
    const sample = heading.value
    if (!heading.available || !sample) return []
    return [joinFields('ROT', [formatNumber(sample.rateOfTurnDegPerMin, 1), heading.valid ? 'A' : 'V'])]
  },
}
