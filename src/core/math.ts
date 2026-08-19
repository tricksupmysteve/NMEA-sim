/**
 * Small, dependency-free numeric helpers shared by the physics, environment and
 * encoder layers. Everything here is pure and side-effect free so it can be
 * exercised directly by unit tests.
 */

export const DEG_TO_RAD = Math.PI / 180
export const RAD_TO_DEG = 180 / Math.PI

/** Clamp `value` into the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  if (value < min) return min
  if (value > max) return max
  return value
}

/** Linear interpolation between `a` and `b`; `t` is clamped to [0, 1]. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp(t, 0, 1)
}

/**
 * Normalise an angle to [0, 360).
 *
 * `-0` is deliberately folded to `0` so encoders never emit `-0.0`.
 */
export function normalizeDegrees360(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0
  const wrapped = degrees % 360
  const positive = wrapped < 0 ? wrapped + 360 : wrapped
  // `359.9999999 % 360` can round to exactly 360 after float noise.
  return positive >= 360 || Object.is(positive, -0) ? 0 : positive
}

/** Normalise an angle to (-180, 180]. */
export function normalizeDegrees180(degrees: number): number {
  const wrapped = normalizeDegrees360(degrees)
  return wrapped > 180 ? wrapped - 360 : wrapped
}

/**
 * Signed shortest difference `to - from`, in (-180, 180].
 * Positive means `to` is clockwise (starboard) of `from`.
 */
export function angleDifference(from: number, to: number): number {
  return normalizeDegrees180(to - from)
}

/**
 * Move `from` towards `to` by at most `maxStep` degrees, taking the short way
 * around the compass.
 */
export function approachAngle(from: number, to: number, maxStep: number): number {
  const delta = angleDifference(from, to)
  const step = clamp(delta, -Math.abs(maxStep), Math.abs(maxStep))
  return normalizeDegrees360(from + step)
}

/** Circular mean of two headings weighted by `t` (0 = a, 1 = b). */
export function blendAngles(a: number, b: number, t: number): number {
  return normalizeDegrees360(a + angleDifference(a, b) * clamp(t, 0, 1))
}

/** Round to a fixed number of decimal places without float tail noise. */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round((value + Number.EPSILON * Math.sign(value || 1)) * factor) / factor
}

/**
 * Exponential smoothing coefficient for a given time constant.
 * Returns the alpha to use in `next = current + (target - current) * alpha`.
 */
export function smoothingAlpha(dtSeconds: number, timeConstantSeconds: number): number {
  if (timeConstantSeconds <= 0) return 1
  return 1 - Math.exp(-Math.max(0, dtSeconds) / timeConstantSeconds)
}

/** Convert polar (degrees clockwise from north, magnitude) to north/east components. */
export function polarToVector(directionDegrees: number, magnitude: number): Vector2 {
  const radians = normalizeDegrees360(directionDegrees) * DEG_TO_RAD
  return {
    north: magnitude * Math.cos(radians),
    east: magnitude * Math.sin(radians),
  }
}

/** Convert north/east components back to polar (degrees clockwise from north). */
export function vectorToPolar(vector: Vector2): { directionDegrees: number; magnitude: number } {
  const magnitude = Math.hypot(vector.north, vector.east)
  if (magnitude < 1e-9) {
    return { directionDegrees: 0, magnitude: 0 }
  }
  return {
    directionDegrees: normalizeDegrees360(Math.atan2(vector.east, vector.north) * RAD_TO_DEG),
    magnitude,
  }
}

export interface Vector2 {
  /** Component towards true north, in the same unit as the magnitude. */
  north: number
  /** Component towards true east, in the same unit as the magnitude. */
  east: number
}

export function addVectors(a: Vector2, b: Vector2): Vector2 {
  return { north: a.north + b.north, east: a.east + b.east }
}

export function subtractVectors(a: Vector2, b: Vector2): Vector2 {
  return { north: a.north - b.north, east: a.east - b.east }
}
