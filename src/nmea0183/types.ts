/**
 * Types shared by the sentence builders.
 *
 * A sentence builder is a pure function of the encode context that returns zero
 * or more sentence *bodies* — address plus fields, with no delimiter, no `*`
 * and no checksum. The encoder adds those, so it is structurally impossible for
 * a sentence to ship without a valid checksum or a CRLF terminator.
 */

import type { BoatState, InstrumentId } from '../types.js'
import type { InstrumentChannels } from '../simulator/instruments.js'
import type { OwnShipIdentity } from '../simulator/world.js'

/** Every sentence formatter the simulator can produce. */
export const SENTENCE_IDS = [
  'RMC',
  'GGA',
  'GLL',
  'VTG',
  'ZDA',
  'GSA',
  'GSV',
  'HDT',
  'HDM',
  'HDG',
  'ROT',
  'VHW',
  'VLW',
  'MWV',
  'MWVT',
  'MWD',
  'DPT',
  'DBT',
  'MTW',
  'XDR',
  'MDA',
  'VDO',
  'VDM',
] as const

export type SentenceId = (typeof SENTENCE_IDS)[number]

export function isSentenceId(value: string): value is SentenceId {
  return (SENTENCE_IDS as readonly string[]).includes(value)
}

export interface EncoderSettings {
  /** Talker identifier per sentence, e.g. `GP` for RMC, `WI` for MWV. */
  talkers: Readonly<Partial<Record<SentenceId, string>>>
  /** Positive east. */
  magneticVariationDegrees: number
  ownShip: OwnShipIdentity
  /** Decimal places used in the minutes part of latitude/longitude. */
  coordinateDecimals: number
  /** Decimal places used in the seconds part of UTC times. */
  timeDecimals: number
}

export interface EncodeContext {
  /** Simulated UTC at the moment of encoding. */
  now: Date
  state: BoatState
  channels: InstrumentChannels
  settings: EncoderSettings
}

export interface SentenceDefinition {
  id: SentenceId
  /** Instruments that must be available for this sentence to be produced. */
  requires: readonly InstrumentId[]
  /** Talker used when the profile does not override it. */
  defaultTalker: string
  /** Default transmission rate in hertz. */
  defaultHz: number
  /** `!` for encapsulated sentences (AIS); `$` otherwise. */
  delimiter?: '$' | '!'
  description: string
  /** NMEA 2000 PGNs this sentence corresponds to, for the future N2K transport. */
  pgns?: readonly number[]
  /**
   * Override the maximum body length. The standard caps a sentence at 82
   * characters (76 of body); a small number of real-world sentences — MDA in
   * particular — routinely exceed that, so they opt out explicitly rather than
   * being silently truncated or silently dropped.
   */
  maxBodyLength?: number
  build(context: EncodeContext): string[]
}

/** Resolve the talker for a sentence, honouring profile overrides. */
export function talkerFor(definition: SentenceDefinition, settings: EncoderSettings): string {
  return settings.talkers[definition.id] ?? definition.defaultTalker
}
