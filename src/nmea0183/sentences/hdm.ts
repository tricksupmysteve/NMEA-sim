/**
 * HDM — Heading, Magnetic.
 */

import { formatDegrees, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const hdm: SentenceDefinition = {
  id: 'HDM',
  requires: ['heading'],
  defaultTalker: 'II',
  defaultHz: 1,
  description: 'Magnetic heading of the vessel',
  pgns: [127250],
  build({ channels }) {
    const heading = channels.heading
    const sample = heading.value
    if (!heading.available || !sample || !heading.valid) return []
    return [joinFields('HDM', [formatDegrees(sample.headingMagnetic, 1), 'M'])]
  },
}
