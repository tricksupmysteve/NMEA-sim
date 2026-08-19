/**
 * HDG — Heading, Deviation and Variation.
 *
 * The magnetic *sensor* heading, plus the corrections needed to turn it into a
 * magnetic and then a true heading.
 */

import { formatDegrees, formatVariation, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const hdg: SentenceDefinition = {
  id: 'HDG',
  requires: ['heading'],
  defaultTalker: 'II',
  defaultHz: 1,
  description: 'Magnetic sensor heading with deviation and variation',
  pgns: [127250],
  build({ channels }) {
    const heading = channels.heading
    const sample = heading.value
    if (!heading.available || !sample || !heading.valid) return []

    const deviation = formatVariation(sample.deviationDegrees)
    const variation = formatVariation(sample.variationDegrees)
    // The sensor reads magnetic heading before deviation is applied.
    const sensorHeading = sample.headingMagnetic - sample.deviationDegrees

    return [
      joinFields('HDG', [
        formatDegrees(sensorHeading, 1),
        deviation.value,
        deviation.direction,
        variation.value,
        variation.direction,
      ]),
    ]
  },
}
