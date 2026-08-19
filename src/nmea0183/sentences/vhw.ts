/**
 * VHW — Water Speed and Heading.
 *
 * Speed *through the water*, which is a different measurement from the SOG
 * reported by VTG/RMC: the difference between them is the current.
 */

import { knotsToKilometresPerHour } from '../../core/units.js'
import { formatDegrees, formatNonNegative, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const vhw: SentenceDefinition = {
  id: 'VHW',
  requires: ['waterSpeed'],
  defaultTalker: 'II',
  defaultHz: 2,
  description: 'Heading and speed through the water',
  pgns: [128259],
  build({ channels }) {
    const waterSpeed = channels.waterSpeed
    const sample = waterSpeed.value
    if (!waterSpeed.available || !sample) return []

    const speed = waterSpeed.valid ? sample.speedThroughWaterKnots : null
    const headingAvailable = channels.heading.available && channels.heading.valid

    return [
      joinFields('VHW', [
        headingAvailable ? formatDegrees(sample.headingTrue, 1) : '',
        'T',
        headingAvailable ? formatDegrees(sample.headingMagnetic, 1) : '',
        'M',
        formatNonNegative(speed, 2),
        'N',
        speed === null ? '' : formatNonNegative(knotsToKilometresPerHour(speed), 2),
        'K',
      ]),
    ]
  },
}
