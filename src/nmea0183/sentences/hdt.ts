/**
 * HDT — Heading, True.
 */

import { formatDegrees, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

export const hdt: SentenceDefinition = {
  id: 'HDT',
  requires: ['heading'],
  defaultTalker: 'II',
  defaultHz: 5,
  description: 'True heading of the vessel',
  pgns: [127250],
  build({ channels }) {
    const heading = channels.heading
    const sample = heading.value
    if (!heading.available || !sample || !heading.valid) return []
    return [joinFields('HDT', [formatDegrees(sample.headingTrue, 1), 'T'])]
  },
}
