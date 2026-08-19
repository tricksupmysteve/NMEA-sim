/**
 * GSA — GNSS DOP and Active Satellites.
 */

import { formatInteger, formatNumber, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const gsa: SentenceDefinition = {
  id: 'GSA',
  requires: ['gps'],
  defaultTalker: 'GP',
  defaultHz: 1,
  description: 'Satellites used for the fix plus PDOP/HDOP/VDOP',
  build({ channels }) {
    const gps = channels.gps
    const sample = gps.value
    if (!gps.available || !sample) return []

    const valid = gps.valid && sample.fixQuality > 0
    const used = sample.satellites.filter((satellite) => satellite.used).slice(0, 12)
    // The satellite ID block is always twelve fields wide, padded with empties.
    const satelliteFields: string[] = Array.from({ length: 12 }, (_unused, index) => {
      const satellite = used[index]
      return valid && satellite ? formatInteger(satellite.prn, 2) : ''
    })

    return [
      joinFields('GSA', [
        // A = automatic 2D/3D switching.
        'A',
        // 1 = no fix, 2 = 2D, 3 = 3D.
        valid ? (used.length >= 4 ? '3' : '2') : '1',
        ...satelliteFields,
        valid ? formatNumber(sample.pdop, 1) : '',
        valid ? formatNumber(sample.hdop, 1) : '',
        valid ? formatNumber(sample.vdop, 1) : '',
      ]),
    ]
  },
}
