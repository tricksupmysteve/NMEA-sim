/**
 * MDA — Meteorological Composite.
 *
 * Deprecated in later NMEA revisions but still widely emitted by weather
 * instruments and understood by chart plotters.
 */

import { normalizeDegrees360 } from '../../core/math.js'
import {
  dewPointCelsius,
  hectopascalsToBars,
  hectopascalsToInchesOfMercury,
  knotsToMetresPerSecond,
} from '../../core/units.js'
import { formatDegrees, formatNonNegative, formatNumber, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const mda: SentenceDefinition = {
  id: 'MDA',
  requires: ['pressure'],
  defaultTalker: 'WI',
  defaultHz: 0.2,
  // A fully populated MDA does not fit the 82-character sentence limit; real
  // weather instruments emit it over-length too, so the cap is relaxed here.
  maxBodyLength: 82,
  description: 'Meteorological composite: pressure, air and water temperature, humidity, wind',
  pgns: [130306, 130313, 130314, 130316],
  build({ channels, settings }) {
    const pressure = channels.pressure
    const sample = pressure.value
    if (!pressure.available || !sample || !pressure.valid) return []

    const wind = channels.wind.available && channels.wind.valid ? channels.wind.value : null
    const water = channels.temperature.available && channels.temperature.valid ? channels.temperature.value : null
    const dewPoint = dewPointCelsius(sample.airTemperatureC, sample.relativeHumidityPercent)

    return [
      joinFields('MDA', [
        formatNumber(hectopascalsToInchesOfMercury(sample.airPressureHpa), 4),
        'I',
        formatNumber(hectopascalsToBars(sample.airPressureHpa), 4),
        'B',
        formatNumber(sample.airTemperatureC, 1),
        'C',
        water ? formatNumber(water.waterTemperatureC, 1) : '',
        'C',
        formatNumber(sample.relativeHumidityPercent, 1),
        // Absolute humidity is not modelled.
        '',
        formatNumber(dewPoint, 1),
        'C',
        wind ? formatDegrees(wind.trueDirectionDegrees, 1) : '',
        'T',
        wind ? formatDegrees(normalizeDegrees360(wind.trueDirectionDegrees - settings.magneticVariationDegrees), 1) : '',
        'M',
        wind ? formatNonNegative(wind.trueSpeedKnots, 1) : '',
        'N',
        wind ? formatNonNegative(knotsToMetresPerSecond(wind.trueSpeedKnots), 1) : '',
        'M',
      ]),
    ]
  },
}
