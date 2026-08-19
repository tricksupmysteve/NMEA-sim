/**
 * MWV — Wind Speed and Angle, measured *relative to the vessel*.
 *
 * Two distinct measurements share this formatter and the reference field tells
 * them apart:
 *
 *   R — relative (apparent) wind: what the masthead unit actually feels.
 *   T — theoretical (true) wind, still expressed as an angle off the bow.
 *
 * They are emitted as separate scheduled sentences (`MWV` and `MWVT`) so each
 * can run at its own rate, and neither is a re-labelling of the other: the
 * apparent values come from the true wind vector plus the vessel's velocity.
 */

import { formatDegrees, formatNonNegative, joinFields } from '../format.js'
import type { SentenceDefinition } from '../types.js'

/** Apparent (relative) wind — the direct masthead measurement. */
export const mwv: SentenceDefinition = {
  id: 'MWV',
  requires: ['wind'],
  defaultTalker: 'WI',
  defaultHz: 5,
  description: 'Apparent (relative) wind angle and speed with validity flag',
  pgns: [130306],
  build({ channels }) {
    const wind = channels.wind
    const sample = wind.value
    if (!wind.available || !sample) return []
    return [
      joinFields('MWV', [
        formatDegrees(sample.apparentAngleDegrees, 1),
        'R',
        formatNonNegative(sample.apparentSpeedKnots, 1),
        'N',
        wind.valid ? 'A' : 'V',
      ]),
    ]
  },
}

/** True wind expressed as an angle off the bow — not the same as MWD. */
export const mwvTrue: SentenceDefinition = {
  id: 'MWVT',
  requires: ['wind'],
  defaultTalker: 'WI',
  defaultHz: 1,
  description: 'True wind angle relative to the bow and true wind speed',
  pgns: [130306],
  build({ channels }) {
    const wind = channels.wind
    const sample = wind.value
    if (!wind.available || !sample) return []
    return [
      joinFields('MWV', [
        formatDegrees(sample.trueAngleDegrees, 1),
        'T',
        formatNonNegative(sample.trueSpeedKnots, 1),
        'N',
        wind.valid ? 'A' : 'V',
      ]),
    ]
  },
}
