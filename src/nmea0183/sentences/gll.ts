/**
 * GLL — Geographic Position, Latitude/Longitude.
 */

import { formatLatitude, formatLongitude, formatUtcTime, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const gll: SentenceDefinition = {
  id: 'GLL',
  requires: ['gps'],
  defaultTalker: 'GP',
  defaultHz: 1,
  description: 'Geographic position: latitude, longitude, UTC, status',
  pgns: [129025],
  build({ channels, settings }) {
    const gps = channels.gps
    const sample = gps.value
    if (!gps.available || !sample) return []

    const valid = gps.valid && sample.fixQuality > 0
    const latitude = formatLatitude(sample.latitude, settings.coordinateDecimals)
    const longitude = formatLongitude(sample.longitude, settings.coordinateDecimals)

    return [
      joinFields('GLL', [
        valid ? latitude.value : '',
        valid ? latitude.hemisphere : '',
        valid ? longitude.value : '',
        valid ? longitude.hemisphere : '',
        formatUtcTime(sample.time, settings.timeDecimals),
        valid ? 'A' : 'V',
        valid ? 'A' : 'N',
      ]),
    ]
  },
}
