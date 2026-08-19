/**
 * GGA — Global Positioning System Fix Data.
 *
 * Carries the fix quality, satellite count, HDOP and antenna altitude that RMC
 * leaves out.
 */

import { formatInteger, formatLatitude, formatLongitude, formatNumber, formatUtcTime, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const gga: SentenceDefinition = {
  id: 'GGA',
  requires: ['gps'],
  defaultTalker: 'GP',
  defaultHz: 1,
  description: 'GNSS fix data: UTC, position, fix quality, satellites, HDOP, altitude',
  pgns: [129029],
  build({ channels, settings }) {
    const gps = channels.gps
    const sample = gps.value
    if (!gps.available || !sample) return []

    const valid = gps.valid && sample.fixQuality > 0
    const latitude = formatLatitude(sample.latitude, settings.coordinateDecimals)
    const longitude = formatLongitude(sample.longitude, settings.coordinateDecimals)

    return [
      joinFields('GGA', [
        formatUtcTime(sample.time, settings.timeDecimals),
        valid ? latitude.value : '',
        valid ? latitude.hemisphere : '',
        valid ? longitude.value : '',
        valid ? longitude.hemisphere : '',
        // 0 = invalid, 1 = GPS SPS, 2 = differential.
        formatInteger(valid ? sample.fixQuality : 0),
        formatInteger(valid ? sample.satellitesUsed : 0, 2),
        valid ? formatNumber(sample.hdop, 1) : '',
        valid ? formatNumber(sample.altitudeMeters, 1) : '',
        'M',
        valid ? formatNumber(sample.geoidSeparationMeters, 1) : '',
        'M',
        // Age of differential data and reference station ID: unused.
        '',
        '',
      ]),
    ]
  },
}
