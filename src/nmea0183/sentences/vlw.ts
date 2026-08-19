/**
 * VLW — Distance Travelled Through Water (total and trip log).
 */

import { formatNonNegative, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const vlw: SentenceDefinition = {
  id: 'VLW',
  requires: ['waterSpeed'],
  defaultTalker: 'II',
  defaultHz: 0.2,
  description: 'Cumulative and trip distance through the water',
  pgns: [128275],
  build({ channels }) {
    const waterSpeed = channels.waterSpeed
    const sample = waterSpeed.value
    if (!waterSpeed.available || !sample || !waterSpeed.valid) return []
    return [
      joinFields('VLW', [
        formatNonNegative(sample.logTotalNm, 2),
        'N',
        formatNonNegative(sample.logTripNm, 2),
        'N',
      ]),
    ]
  },
}
