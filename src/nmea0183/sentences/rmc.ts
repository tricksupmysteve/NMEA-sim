/**
 * RMC — Recommended Minimum Specific GNSS Data.
 *
 * The workhorse position sentence: UTC, status, position, SOG, COG, date and
 * magnetic variation.
 */

import { formatDegrees, formatLatitude, formatLongitude, formatNonNegative, formatUtcDate, formatUtcTime, formatVariation, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const rmc: SentenceDefinition = {
  id: 'RMC',
  requires: ['gps'],
  defaultTalker: 'GP',
  defaultHz: 1,
  description: 'Recommended minimum GNSS data: UTC, status, position, SOG, COG, date, variation',
  pgns: [129025, 129026, 129029],
  build({ channels, settings }) {
    const gps = channels.gps
    const sample = gps.value
    if (!gps.available || !sample) return []

    const valid = gps.valid && sample.fixQuality > 0
    const latitude = formatLatitude(sample.latitude, settings.coordinateDecimals)
    const longitude = formatLongitude(sample.longitude, settings.coordinateDecimals)
    const variation = formatVariation(settings.magneticVariationDegrees)

    return [
      joinFields(`RMC`, [
        formatUtcTime(sample.time, settings.timeDecimals),
        // A = data valid, V = navigation receiver warning.
        valid ? 'A' : 'V',
        // With no valid fix the position fields are transmitted empty.
        valid ? latitude.value : '',
        valid ? latitude.hemisphere : '',
        valid ? longitude.value : '',
        valid ? longitude.hemisphere : '',
        valid ? formatNonNegative(sample.sogKnots, 1) : '',
        valid ? formatDegrees(sample.cogDegrees, 1) : '',
        formatUtcDate(sample.time),
        variation.value,
        variation.direction,
        // Mode indicator (NMEA 0183 v2.3): A autonomous, N data not valid.
        valid ? 'A' : 'N',
      ]),
    ]
  },
}
