/**
 * Field formatters for NMEA 0183.
 *
 * The hard rule enforced here: a sentence must never contain `NaN`,
 * `undefined`, `Infinity`, a malformed decimal or an out-of-range coordinate.
 * Every formatter takes a possibly-hostile number and either renders a valid
 * field or renders an empty field — which is what NMEA uses for "no data".
 */

import { clamp, normalizeDegrees360, roundTo } from '../core/math.js'

/** An empty NMEA field means "this talker has no value for this". */
export const EMPTY_FIELD = ''

/** `true` when a value is safe to render as a number. */
export function isRenderable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Fixed-point number. Returns an empty field rather than `NaN`/`Infinity`.
 * `-0` is normalised to `0`.
 */
export function formatNumber(value: number | null | undefined, decimals: number): string {
  if (!isRenderable(value)) return EMPTY_FIELD
  const rounded = roundTo(value, decimals)
  const safe = Object.is(rounded, -0) ? 0 : rounded
  return safe.toFixed(Math.max(0, Math.min(10, decimals)))
}

/** Non-negative fixed-point number; negatives are clamped to zero. */
export function formatNonNegative(value: number | null | undefined, decimals: number): string {
  if (!isRenderable(value)) return EMPTY_FIELD
  return formatNumber(Math.max(0, value), decimals)
}

/** Zero-padded integer, e.g. satellite counts. */
export function formatInteger(value: number | null | undefined, width = 0): string {
  if (!isRenderable(value)) return EMPTY_FIELD
  const rounded = Math.trunc(value)
  const text = Math.abs(rounded).toString().padStart(width, '0')
  return rounded < 0 ? `-${text}` : text
}

/**
 * Angle in degrees, wrapped into [0, 360) *after* rounding so a value such as
 * 359.97 renders as `0.0`, never `360.0`.
 */
export function formatDegrees(value: number | null | undefined, decimals = 1): string {
  if (!isRenderable(value)) return EMPTY_FIELD
  const rounded = roundTo(normalizeDegrees360(value), decimals)
  return formatNumber(rounded >= 360 ? 0 : rounded, decimals)
}

/**
 * Latitude as `ddmm.mmmm` plus its hemisphere.
 *
 * Degrees are zero-padded to two digits and minutes to two integer digits, as
 * required by the standard.
 */
export function formatLatitude(latitude: number | null | undefined, decimals = 4): { value: string; hemisphere: string } {
  if (!isRenderable(latitude)) return { value: EMPTY_FIELD, hemisphere: EMPTY_FIELD }
  const bounded = clamp(latitude, -90, 90)
  const hemisphere = bounded < 0 ? 'S' : 'N'
  const absolute = Math.abs(bounded)
  let degrees = Math.floor(absolute)
  let minutes = (absolute - degrees) * 60
  // Rounding minutes can carry into the degrees; do the carry explicitly.
  if (roundTo(minutes, decimals) >= 60) {
    minutes = 0
    degrees += 1
  }
  if (degrees > 90) {
    degrees = 90
    minutes = 0
  }
  return {
    value: `${degrees.toString().padStart(2, '0')}${padMinutes(minutes, decimals)}`,
    hemisphere,
  }
}

/** Longitude as `dddmm.mmmm` plus its hemisphere. */
export function formatLongitude(longitude: number | null | undefined, decimals = 4): { value: string; hemisphere: string } {
  if (!isRenderable(longitude)) return { value: EMPTY_FIELD, hemisphere: EMPTY_FIELD }
  let bounded = ((longitude + 180) % 360 + 360) % 360 - 180
  if (Object.is(bounded, -0)) bounded = 0
  const hemisphere = bounded < 0 ? 'W' : 'E'
  const absolute = Math.abs(bounded)
  let degrees = Math.floor(absolute)
  let minutes = (absolute - degrees) * 60
  if (roundTo(minutes, decimals) >= 60) {
    minutes = 0
    degrees += 1
  }
  if (degrees > 180) {
    degrees = 180
    minutes = 0
  }
  return {
    value: `${degrees.toString().padStart(3, '0')}${padMinutes(minutes, decimals)}`,
    hemisphere,
  }
}

function padMinutes(minutes: number, decimals: number): string {
  const text = roundTo(minutes, decimals).toFixed(decimals)
  // `9.1234` must render as `09.1234`.
  const [whole = '0', fraction = ''] = text.split('.')
  const paddedWhole = whole.padStart(2, '0')
  return decimals > 0 ? `${paddedWhole}.${fraction}` : paddedWhole
}

/** UTC time of day as `hhmmss.ss`. */
export function formatUtcTime(date: Date, decimals = 2): string {
  if (!isValidDate(date)) return EMPTY_FIELD
  const hours = date.getUTCHours().toString().padStart(2, '0')
  const minutes = date.getUTCMinutes().toString().padStart(2, '0')
  const seconds = date.getUTCSeconds()
  const milliseconds = date.getUTCMilliseconds()
  if (decimals <= 0) {
    return `${hours}${minutes}${seconds.toString().padStart(2, '0')}`
  }
  const fractional = (seconds + milliseconds / 1000).toFixed(decimals).padStart(decimals + 3, '0')
  return `${hours}${minutes}${fractional}`
}

/** UTC date as `ddmmyy`. */
export function formatUtcDate(date: Date): string {
  if (!isValidDate(date)) return EMPTY_FIELD
  const day = date.getUTCDate().toString().padStart(2, '0')
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const year = (date.getUTCFullYear() % 100).toString().padStart(2, '0')
  return `${day}${month}${year}`
}

export function isValidDate(date: Date | null | undefined): date is Date {
  return date instanceof Date && Number.isFinite(date.getTime())
}

/**
 * Magnetic variation as a magnitude plus `E`/`W`.
 *
 * Input is signed with east positive, which is the convention used throughout
 * the simulator; NMEA wants magnitude and hemisphere.
 */
export function formatVariation(
  variationDegrees: number | null | undefined,
  decimals = 1,
): { value: string; direction: string } {
  if (!isRenderable(variationDegrees)) return { value: EMPTY_FIELD, direction: EMPTY_FIELD }
  const bounded = clamp(variationDegrees, -180, 180)
  return {
    value: formatNumber(Math.abs(bounded), decimals),
    direction: bounded < 0 ? 'W' : 'E',
  }
}

/**
 * Join fields into a sentence body. `undefined`/`null` fields become empty
 * fields, which is exactly what the standard expects for missing data.
 */
export function joinFields(address: string, fields: ReadonlyArray<string | number | null | undefined>): string {
  const rendered = fields.map((field) => {
    if (field === null || field === undefined) return EMPTY_FIELD
    if (typeof field === 'number') return formatNumber(field, 1)
    return field
  })
  return [address, ...rendered].join(',')
}
