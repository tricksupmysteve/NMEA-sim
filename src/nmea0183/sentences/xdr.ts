/**
 * XDR — Transducer Measurements.
 *
 * A generic carrier for anything that does not have a dedicated sentence. The
 * simulator uses it for attitude (heel/pitch), barometric pressure, air
 * temperature and humidity, in groups of four measurements per sentence.
 */

import { hectopascalsToBars } from '../../core/units.js'
import { formatNumber, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

interface Transducer {
  /** A = angular displacement, P = pressure, C = temperature, H = humidity. */
  type: string
  value: number
  units: string
  id: string
}

/**
 * Three per sentence rather than the permitted four: a barometer group is long
 * enough that four would push the sentence past the 82-character limit.
 */
const MEASUREMENTS_PER_SENTENCE = 3

export const xdr: SentenceDefinition = {
  id: 'XDR',
  requires: [],
  defaultTalker: 'YX',
  defaultHz: 1,
  description: 'Transducer measurements: heel, pitch, barometric pressure, air temperature, humidity',
  pgns: [127257, 130313, 130314, 130316],
  build({ channels }) {
    const transducers: Transducer[] = []

    const attitude = channels.attitude
    if (attitude.available && attitude.valid && attitude.value) {
      transducers.push({ type: 'A', value: attitude.value.heelDegrees, units: 'D', id: 'ROLL' })
      transducers.push({ type: 'A', value: attitude.value.pitchDegrees, units: 'D', id: 'PTCH' })
    }

    const pressure = channels.pressure
    if (pressure.available && pressure.valid && pressure.value) {
      transducers.push({ type: 'P', value: hectopascalsToBars(pressure.value.airPressureHpa), units: 'B', id: 'Barometer' })
      transducers.push({ type: 'C', value: pressure.value.airTemperatureC, units: 'C', id: 'AirTemp' })
      transducers.push({ type: 'H', value: pressure.value.relativeHumidityPercent, units: 'P', id: 'Humidity' })
    }

    const temperature = channels.temperature
    if (temperature.available && temperature.valid && temperature.value) {
      transducers.push({ type: 'C', value: temperature.value.waterTemperatureC, units: 'C', id: 'WaterTemp' })
    }

    if (transducers.length === 0) return []

    const sentences: string[] = []
    for (let index = 0; index < transducers.length; index += MEASUREMENTS_PER_SENTENCE) {
      const group = transducers.slice(index, index + MEASUREMENTS_PER_SENTENCE)
      const fields: string[] = []
      for (const transducer of group) {
        // Pressure in bars needs more precision than one decimal place.
        const decimals = transducer.units === 'B' ? 5 : 1
        fields.push(transducer.type, formatNumber(transducer.value, decimals), transducer.units, transducer.id)
      }
      sentences.push(joinFields('XDR', fields))
    }
    return sentences
  },
}
