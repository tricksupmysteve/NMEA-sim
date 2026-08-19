/**
 * Output profiles.
 *
 * A profile is a named set of sentences, talker identifiers and default rates.
 *
 * `garmin-wifi` mirrors the shape of a Garmin-style NMEA-0183-over-Wi-Fi
 * gateway: the standard sentence set such a device typically translates or
 * broadcasts, delivered as a raw TCP stream. It is a *standards-based* profile
 * — no Garmin Marine Network or BlueNet proprietary protocol is implemented,
 * emulated or reverse engineered here, and none is required to use it.
 */

import type { SentenceId } from './types.js'

export const PROFILE_NAMES = ['garmin-wifi', 'garmin-wifi-full', 'minimal', 'full'] as const

export type ProfileName = (typeof PROFILE_NAMES)[number]

export function isProfileName(value: string): value is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value)
}

export interface SentenceProfileEntry {
  id: SentenceId
  /** Transmission rate in hertz. */
  hz: number
  /** Talker identifier override; the sentence default is used when omitted. */
  talker?: string
}

export interface Profile {
  name: ProfileName
  description: string
  sentences: readonly SentenceProfileEntry[]
}

/**
 * Talkers chosen to match what a typical marine instrument network puts on the
 * wire: GP for the GNSS receiver, II for the integrated instrument bus, WI for
 * the wind/weather instrument, SD for the depth sounder, YX for a generic
 * transducer, AI for AIS.
 */
const PRIMARY: readonly SentenceProfileEntry[] = [
  { id: 'HDT', hz: 5, talker: 'II' },
  { id: 'MWV', hz: 5, talker: 'WI' },
  { id: 'VHW', hz: 2, talker: 'II' },
  { id: 'RMC', hz: 1, talker: 'GP' },
  { id: 'GGA', hz: 1, talker: 'GP' },
  { id: 'VTG', hz: 1, talker: 'GP' },
  { id: 'MWD', hz: 1, talker: 'WI' },
  { id: 'DPT', hz: 1, talker: 'SD' },
  { id: 'MTW', hz: 0.2, talker: 'WI' },
]

const GARMIN_EXTRA: readonly SentenceProfileEntry[] = [
  { id: 'HDG', hz: 1, talker: 'II' },
  { id: 'HDM', hz: 1, talker: 'II' },
  { id: 'DBT', hz: 1, talker: 'SD' },
  { id: 'GSA', hz: 1, talker: 'GP' },
  { id: 'GSV', hz: 0.2, talker: 'GP' },
  { id: 'XDR', hz: 1, talker: 'YX' },
  { id: 'MWVT', hz: 1, talker: 'WI' },
]

const FULL_EXTRA: readonly SentenceProfileEntry[] = [
  { id: 'GLL', hz: 1, talker: 'GP' },
  { id: 'ZDA', hz: 1, talker: 'GP' },
  { id: 'ROT', hz: 1, talker: 'II' },
  { id: 'VLW', hz: 0.2, talker: 'II' },
  { id: 'MDA', hz: 0.2, talker: 'WI' },
  { id: 'VDO', hz: 0.2, talker: 'AI' },
  { id: 'VDM', hz: 0.2, talker: 'AI' },
]

export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  'garmin-wifi': {
    name: 'garmin-wifi',
    description:
      'Garmin-style NMEA 0183 over Wi-Fi/TCP: the prioritised first-version sentence set (RMC, GGA, VTG, HDT, VHW, MWV, MWD, DPT, MTW). Standards-based, not a proprietary Garmin protocol.',
    sentences: PRIMARY,
  },
  'garmin-wifi-full': {
    name: 'garmin-wifi-full',
    description:
      'As garmin-wifi plus the wider set such gateways commonly translate: GSA, GSV, HDG, HDM, DBT, XDR and true-referenced MWV.',
    sentences: [...PRIMARY, ...GARMIN_EXTRA],
  },
  minimal: {
    name: 'minimal',
    description: 'Position and heading only — RMC, GGA, VTG, HDT. Useful for isolating a consumer’s GPS path.',
    sentences: PRIMARY.filter((entry) => ['RMC', 'GGA', 'VTG', 'HDT'].includes(entry.id)),
  },
  full: {
    name: 'full',
    description: 'Everything the simulator can produce, including optional AIS, MDA and log sentences.',
    sentences: [...PRIMARY, ...GARMIN_EXTRA, ...FULL_EXTRA],
  },
}

export function getProfile(name: ProfileName): Profile {
  return PROFILES[name]
}
