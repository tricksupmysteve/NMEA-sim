/**
 * GSV — GNSS Satellites in View.
 *
 * Emits as many sentences as needed, four satellites per sentence.
 */

import { formatDegrees, formatInteger, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

const SATELLITES_PER_SENTENCE = 4

export const gsv: SentenceDefinition = {
  id: 'GSV',
  requires: ['gps'],
  defaultTalker: 'GP',
  defaultHz: 0.2,
  description: 'Satellites in view with elevation, azimuth and signal strength',
  build({ channels }) {
    const gps = channels.gps
    const sample = gps.value
    if (!gps.available || !sample || !gps.valid) return []

    const satellites = sample.satellites
    if (satellites.length === 0) return []

    const total = Math.ceil(satellites.length / SATELLITES_PER_SENTENCE)
    const sentences: string[] = []

    for (let index = 0; index < total; index += 1) {
      const slice = satellites.slice(index * SATELLITES_PER_SENTENCE, (index + 1) * SATELLITES_PER_SENTENCE)
      const fields: string[] = []
      for (const satellite of slice) {
        fields.push(
          formatInteger(satellite.prn, 2),
          formatInteger(Math.round(satellite.elevationDegrees), 2),
          formatDegrees(satellite.azimuthDegrees, 0).padStart(3, '0'),
          formatInteger(Math.round(satellite.signalToNoiseDb), 2),
        )
      }
      sentences.push(
        joinFields('GSV', [
          formatInteger(total),
          formatInteger(index + 1),
          formatInteger(satellites.length, 2),
          ...fields,
        ]),
      )
    }

    return sentences
  },
}
