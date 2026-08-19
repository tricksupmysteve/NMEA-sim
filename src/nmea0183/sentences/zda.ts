/**
 * ZDA — Time and Date (UTC, day, month, year and local time zone).
 */

import { formatInteger, formatUtcTime, isValidDate, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const zda: SentenceDefinition = {
  id: 'ZDA',
  requires: ['gps'],
  defaultTalker: 'GP',
  defaultHz: 1,
  description: 'UTC time and date with local zone offset',
  build({ channels, settings }) {
    const gps = channels.gps
    const sample = gps.value
    if (!gps.available || !sample || !isValidDate(sample.time)) return []

    return [
      joinFields('ZDA', [
        formatUtcTime(sample.time, settings.timeDecimals),
        formatInteger(sample.time.getUTCDate(), 2),
        formatInteger(sample.time.getUTCMonth() + 1, 2),
        formatInteger(sample.time.getUTCFullYear(), 4),
        // The simulator runs on UTC, so the local zone offset is zero.
        '00',
        '00',
      ]),
    ]
  },
}
