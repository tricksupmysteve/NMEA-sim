/**
 * MTW — Water Temperature, degrees Celsius.
 */

import { formatNumber, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const mtw: SentenceDefinition = {
  id: 'MTW',
  requires: ['temperature'],
  defaultTalker: 'WI',
  defaultHz: 0.2,
  description: 'Water temperature in degrees Celsius',
  pgns: [130316],
  build({ channels }) {
    const temperature = channels.temperature
    const sample = temperature.value
    if (!temperature.available || !sample || !temperature.valid) return []
    return [joinFields('MTW', [formatNumber(sample.waterTemperatureC, 1), 'C'])]
  },
}
