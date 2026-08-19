/**
 * VDO / VDM — AIS own-ship and target reports.
 *
 * These are *encapsulated* sentences: they begin with `!` rather than `$`, but
 * they carry the same XOR checksum and CRLF termination as everything else.
 */

import { buildPositionReport, buildVdmBody } from '../ais/messages.js'
import type { SentenceDefinition } from '../types.js'

export const vdo: SentenceDefinition = {
  id: 'VDO',
  requires: ['ais'],
  defaultTalker: 'AI',
  defaultHz: 0.2,
  delimiter: '!',
  description: 'AIS own-ship position report (class A, message type 1)',
  build({ channels, now }) {
    const ais = channels.ais
    const sample = ais.value
    if (!ais.available || !sample || !ais.valid) return []
    const { payload, fillBits } = buildPositionReport({ target: sample.own, utcSecond: now.getUTCSeconds() })
    return [buildVdmBody('VDO', payload, fillBits, 'A')]
  },
}

export const vdm: SentenceDefinition = {
  id: 'VDM',
  requires: ['ais'],
  defaultTalker: 'AI',
  defaultHz: 0.2,
  delimiter: '!',
  description: 'AIS target position reports (class A, message type 1)',
  build({ channels, now }) {
    const ais = channels.ais
    const sample = ais.value
    if (!ais.available || !sample || !ais.valid) return []
    return sample.targets.map((target, index) => {
      const { payload, fillBits } = buildPositionReport({ target, utcSecond: now.getUTCSeconds() })
      // Alternate the AIS radio channel, as a real receiver would.
      return buildVdmBody('VDM', payload, fillBits, index % 2 === 0 ? 'A' : 'B')
    })
  },
}
