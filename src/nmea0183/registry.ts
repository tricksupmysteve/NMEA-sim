/**
 * The sentence registry: every formatter the simulator knows how to produce.
 *
 * Adding a sentence means writing one builder and adding it here — the
 * scheduler, the profiles, the control API and the console all read from this
 * table, so nothing else needs to change.
 */

import { vdm, vdo } from './sentences/ais.js'
import { dbt } from './sentences/dbt.js'
import { dpt } from './sentences/dpt.js'
import { gga } from './sentences/gga.js'
import { gll } from './sentences/gll.js'
import { gsa } from './sentences/gsa.js'
import { gsv } from './sentences/gsv.js'
import { hdg } from './sentences/hdg.js'
import { hdm } from './sentences/hdm.js'
import { hdt } from './sentences/hdt.js'
import { mda } from './sentences/mda.js'
import { mtw } from './sentences/mtw.js'
import { mwd } from './sentences/mwd.js'
import { mwv, mwvTrue } from './sentences/mwv.js'
import { rmc } from './sentences/rmc.js'
import { rot } from './sentences/rot.js'
import { vhw } from './sentences/vhw.js'
import { vlw } from './sentences/vlw.js'
import { vtg } from './sentences/vtg.js'
import { xdr } from './sentences/xdr.js'
import { zda } from './sentences/zda.js'
import type { SentenceDefinition, SentenceId } from './types.js'

const DEFINITIONS: readonly SentenceDefinition[] = [
  rmc,
  gga,
  gll,
  vtg,
  zda,
  gsa,
  gsv,
  hdt,
  hdm,
  hdg,
  rot,
  vhw,
  vlw,
  mwv,
  mwvTrue,
  mwd,
  dpt,
  dbt,
  mtw,
  xdr,
  mda,
  vdo,
  vdm,
]

export const SENTENCE_REGISTRY: ReadonlyMap<SentenceId, SentenceDefinition> = new Map(
  DEFINITIONS.map((definition) => [definition.id, definition]),
)

export function getSentenceDefinition(id: SentenceId): SentenceDefinition {
  const definition = SENTENCE_REGISTRY.get(id)
  if (!definition) throw new Error(`Unknown NMEA sentence: ${id}`)
  return definition
}

export function allSentenceDefinitions(): SentenceDefinition[] {
  return [...SENTENCE_REGISTRY.values()]
}
