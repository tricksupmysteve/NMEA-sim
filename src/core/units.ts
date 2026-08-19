/**
 * Unit conversions.
 *
 * The simulator keeps a single canonical internal representation (knots for
 * speeds, degrees for angles, metres for distances, Celsius for temperature)
 * and converts *only* at the protocol encoding boundary.
 */

export const METRES_PER_NAUTICAL_MILE = 1852
export const METRES_PER_FOOT = 0.3048
export const METRES_PER_FATHOM = 1.8288

export function knotsToMetresPerSecond(knots: number): number {
  return (knots * METRES_PER_NAUTICAL_MILE) / 3600
}

export function metresPerSecondToKnots(metresPerSecond: number): number {
  return (metresPerSecond * 3600) / METRES_PER_NAUTICAL_MILE
}

export function knotsToKilometresPerHour(knots: number): number {
  return (knots * METRES_PER_NAUTICAL_MILE) / 1000
}

export function metresToFeet(metres: number): number {
  return metres / METRES_PER_FOOT
}

export function metresToFathoms(metres: number): number {
  return metres / METRES_PER_FATHOM
}

export function hectopascalsToBars(hectopascals: number): number {
  return hectopascals / 1000
}

export function hectopascalsToInchesOfMercury(hectopascals: number): number {
  return hectopascals / 33.863886666667
}

export function celsiusToKelvin(celsius: number): number {
  return celsius + 273.15
}

/**
 * Magnus-formula dew point. Used by the optional MDA sentence.
 */
export function dewPointCelsius(airTemperatureC: number, relativeHumidityPercent: number): number {
  const humidity = Math.min(100, Math.max(1, relativeHumidityPercent))
  const a = 17.27
  const b = 237.7
  const gamma = (a * airTemperatureC) / (b + airTemperatureC) + Math.log(humidity / 100)
  return (b * gamma) / (a - gamma)
}
