/**
 * Marine physics.
 *
 * Every function here is pure so the relationships that matter — true wind plus
 * boat velocity gives apparent wind, water track plus current gives ground
 * track — can be unit tested directly and reused by future transports.
 *
 * Angle convention throughout: degrees clockwise from true north. Wind
 * *directions* are meteorological, i.e. the direction the wind blows **from**.
 */

import {
  DEG_TO_RAD,
  clamp,
  normalizeDegrees180,
  normalizeDegrees360,
  polarToVector,
  vectorToPolar,
  type Vector2,
} from '../core/math.js'
import { METRES_PER_NAUTICAL_MILE, knotsToMetresPerSecond } from '../core/units.js'

/** WGS84 ellipsoid parameters. */
const WGS84_SEMI_MAJOR_METRES = 6378137
const WGS84_FLATTENING = 1 / 298.257223563
const WGS84_ECCENTRICITY_SQUARED = WGS84_FLATTENING * (2 - WGS84_FLATTENING)

/** Metres per degree of latitude at a given latitude (meridional radius). */
export function metresPerDegreeLatitude(latitudeDegrees: number): number {
  const latitude = clamp(latitudeDegrees, -89.9999, 89.9999) * DEG_TO_RAD
  const sinLatitude = Math.sin(latitude)
  const denominator = (1 - WGS84_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude) ** 1.5
  const meridionalRadius = (WGS84_SEMI_MAJOR_METRES * (1 - WGS84_ECCENTRICITY_SQUARED)) / denominator
  return (Math.PI / 180) * meridionalRadius
}

/** Metres per degree of longitude at a given latitude (normal radius). */
export function metresPerDegreeLongitude(latitudeDegrees: number): number {
  const latitude = clamp(latitudeDegrees, -89.9999, 89.9999) * DEG_TO_RAD
  const sinLatitude = Math.sin(latitude)
  const normalRadius = WGS84_SEMI_MAJOR_METRES / Math.sqrt(1 - WGS84_ECCENTRICITY_SQUARED * sinLatitude * sinLatitude)
  return (Math.PI / 180) * normalRadius * Math.cos(latitude)
}

export interface GeoPosition {
  latitude: number
  longitude: number
}

/**
 * Advance a position along a ground track.
 *
 * Uses a local flat-earth projection with WGS84 scale factors, which is exact
 * to well under a metre for the sub-second steps the simulator takes.
 */
export function advancePosition(
  position: GeoPosition,
  courseOverGroundDegrees: number,
  speedOverGroundKnots: number,
  dtSeconds: number,
): GeoPosition {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return { ...position }
  const distanceMetres = knotsToMetresPerSecond(Math.max(0, speedOverGroundKnots)) * dtSeconds
  const { north, east } = polarToVector(courseOverGroundDegrees, distanceMetres)

  const latitude = clamp(position.latitude + north / metresPerDegreeLatitude(position.latitude), -89.9, 89.9)
  const metresPerDegreeLon = metresPerDegreeLongitude(position.latitude)
  const longitude =
    metresPerDegreeLon < 1e-6 ? position.longitude : position.longitude + east / metresPerDegreeLon

  return { latitude, longitude: wrapLongitude(longitude) }
}

/** Keep longitude in [-180, 180). */
export function wrapLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) return 0
  let wrapped = ((longitude + 180) % 360 + 360) % 360 - 180
  if (Object.is(wrapped, -0)) wrapped = 0
  return wrapped
}

/**
 * Mean Earth radius (IUGG), used for the spherical great-circle helpers below.
 * Those helpers are for reporting and tests; the position integrator uses the
 * local WGS84 scale factors instead, so the two agree to roughly half a percent
 * rather than exactly.
 */
const MEAN_EARTH_RADIUS_METRES = 6371008.8

/** Great-circle distance in nautical miles (haversine, spherical Earth). */
export function distanceNauticalMiles(from: GeoPosition, to: GeoPosition): number {
  const lat1 = from.latitude * DEG_TO_RAD
  const lat2 = to.latitude * DEG_TO_RAD
  const dLat = lat2 - lat1
  const dLon = (to.longitude - from.longitude) * DEG_TO_RAD
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  const metres = 2 * MEAN_EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a)))
  return metres / METRES_PER_NAUTICAL_MILE
}

/** Initial great-circle bearing from one position to another, degrees true. */
export function bearingDegrees(from: GeoPosition, to: GeoPosition): number {
  const lat1 = from.latitude * DEG_TO_RAD
  const lat2 = to.latitude * DEG_TO_RAD
  const dLon = (to.longitude - from.longitude) * DEG_TO_RAD
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return normalizeDegrees360(Math.atan2(y, x) * (180 / Math.PI))
}

export interface GroundTrack {
  /** Course over ground, degrees true. */
  cogDegrees: number
  /** Speed over ground, knots. */
  sogKnots: number
}

/**
 * Combine the vessel's track through the water with the surface current to get
 * the track over the ground.
 *
 * `waterTrackDegrees` is heading + leeway; `setDegrees` is the direction the
 * current flows **towards**.
 */
export function groundTrackFromWaterTrack(
  waterTrackDegrees: number,
  speedThroughWaterKnots: number,
  currentSetDegrees: number,
  currentDriftKnots: number,
): GroundTrack {
  const throughWater = polarToVector(waterTrackDegrees, Math.max(0, speedThroughWaterKnots))
  const current = polarToVector(currentSetDegrees, Math.max(0, currentDriftKnots))
  const overGround: Vector2 = {
    north: throughWater.north + current.north,
    east: throughWater.east + current.east,
  }
  const polar = vectorToPolar(overGround)
  return {
    // With no motion at all COG is meaningless; hold the water track so the
    // encoder never publishes a jittering course for a stationary vessel.
    cogDegrees: polar.magnitude < 1e-6 ? normalizeDegrees360(waterTrackDegrees) : polar.directionDegrees,
    sogKnots: polar.magnitude,
  }
}

export interface ApparentWind {
  /** Apparent wind angle relative to the bow, 0-360 clockwise from ahead. */
  angleDegrees: number
  /** Signed apparent wind angle, (-180, 180]; negative = port. */
  signedAngleDegrees: number
  /** Apparent wind speed, knots. */
  speedKnots: number
  /** Apparent wind direction over the ground, degrees true (blowing from). */
  directionDegreesTrue: number
}

/**
 * Derive apparent wind from the true wind vector and the vessel's velocity.
 *
 *     apparent-wind-from vector = TWS * unit(TWD) + SOG * unit(COG)
 *
 * (Both terms point *towards where the air comes from* in the vessel frame:
 * the meteorological true wind, plus the head wind the vessel makes for
 * itself by moving.)
 *
 * This is the only place apparent wind is produced. AWS/AWA are never
 * randomised independently of TWS/TWD, so tacking, gybing, accelerating and
 * slowing all move the apparent wind correctly.
 */
export function apparentWind(
  trueWindDirectionDegrees: number,
  trueWindSpeedKnots: number,
  headingDegrees: number,
  speedOverGroundKnots: number,
  courseOverGroundDegrees: number,
): ApparentWind {
  const trueWindFrom = polarToVector(trueWindDirectionDegrees, Math.max(0, trueWindSpeedKnots))
  const vesselMotion = polarToVector(courseOverGroundDegrees, Math.max(0, speedOverGroundKnots))
  const apparentFrom: Vector2 = {
    north: trueWindFrom.north + vesselMotion.north,
    east: trueWindFrom.east + vesselMotion.east,
  }
  const polar = vectorToPolar(apparentFrom)
  const directionDegreesTrue = polar.magnitude < 1e-6
    ? normalizeDegrees360(trueWindDirectionDegrees)
    : polar.directionDegrees
  const angleDegrees = normalizeDegrees360(directionDegreesTrue - headingDegrees)
  return {
    angleDegrees,
    signedAngleDegrees: normalizeDegrees180(angleDegrees),
    speedKnots: polar.magnitude,
    directionDegreesTrue,
  }
}

export interface TrueWind {
  /** True wind direction, degrees true (blowing from). */
  directionDegrees: number
  trueSpeedKnots: number
  /** True wind angle relative to the bow, 0-360 clockwise. */
  angleDegrees: number
}

/**
 * Inverse of {@link apparentWind}: recover the true wind from a measured
 * apparent wind and the vessel's motion. Exposed for tests (round-tripping
 * proves the vector maths) and for future sentence-driven calibration.
 */
export function trueWindFromApparent(
  apparentAngleDegrees: number,
  apparentSpeedKnots: number,
  headingDegrees: number,
  speedOverGroundKnots: number,
  courseOverGroundDegrees: number,
): TrueWind {
  const apparentDirection = normalizeDegrees360(headingDegrees + apparentAngleDegrees)
  const apparentFrom = polarToVector(apparentDirection, Math.max(0, apparentSpeedKnots))
  const vesselMotion = polarToVector(courseOverGroundDegrees, Math.max(0, speedOverGroundKnots))
  const trueFrom: Vector2 = {
    north: apparentFrom.north - vesselMotion.north,
    east: apparentFrom.east - vesselMotion.east,
  }
  const polar = vectorToPolar(trueFrom)
  const directionDegrees = polar.magnitude < 1e-6 ? apparentDirection : polar.directionDegrees
  return {
    directionDegrees,
    trueSpeedKnots: polar.magnitude,
    angleDegrees: normalizeDegrees360(directionDegrees - headingDegrees),
  }
}

/** True wind angle relative to the bow, 0-360 clockwise. */
export function trueWindAngle(trueWindDirectionDegrees: number, headingDegrees: number): number {
  return normalizeDegrees360(trueWindDirectionDegrees - headingDegrees)
}

/**
 * Leeway: the sideways slip of a sailing hull, largest when hard on the wind
 * and negligible under power or dead downwind. Sign follows the wind — a boat
 * with the wind on the starboard bow slips to port.
 */
export function leewayDegrees(
  trueWindAngleDegrees: number,
  heelDegrees: number,
  speedThroughWaterKnots: number,
  coefficient: number,
): number {
  if (coefficient <= 0) return 0
  // The speed floor keeps the 1/v² term finite when the boat is barely moving;
  // a stopped boat makes no leeway anyway.
  const speed = Math.max(1.5, speedThroughWaterKnots)
  const signedTwa = normalizeDegrees180(trueWindAngleDegrees)
  // Falls off to zero on a dead run and dead beat-to-nothing.
  const upwindFactor = Math.max(0, Math.cos(signedTwa * DEG_TO_RAD * 0.9))
  const magnitude = (coefficient * Math.abs(heelDegrees)) / (speed * speed)
  return clamp(-Math.sign(signedTwa) * magnitude * upwindFactor, -12, 12)
}

/**
 * Steady heel angle from the apparent wind's heeling moment, damped by the
 * righting moment. Not a naval-architecture model — a plausible, bounded curve
 * so heel responds to gusts and to bearing away.
 */
export function heelFromWind(
  apparentAngleDegrees: number,
  apparentSpeedKnots: number,
  stiffness: number,
  maximumHeelDegrees: number,
): number {
  if (stiffness <= 0) return 0
  const signedAngle = normalizeDegrees180(apparentAngleDegrees)
  const sideForce = Math.sin(signedAngle * DEG_TO_RAD)
  const pressure = apparentSpeedKnots * apparentSpeedKnots
  const heel = (pressure * sideForce) / stiffness
  return clamp(heel, -maximumHeelDegrees, maximumHeelDegrees)
}

/**
 * Significant wave height from wind speed and fetch, using a simplified
 * fetch-limited approximation. Drives pitch, heave and the depth sounder's
 * short-term noise.
 */
export function significantWaveHeight(windSpeedKnots: number, fetchFactor: number): number {
  const windMetresPerSecond = knotsToMetresPerSecond(Math.max(0, windSpeedKnots))
  const height = 0.0248 * windMetresPerSecond * windMetresPerSecond * clamp(fetchFactor, 0, 2)
  return clamp(height, 0, 14)
}

/** Wave period estimated from significant wave height. */
export function waveperiodSeconds(significantWaveHeightMetres: number): number {
  return clamp(3.5 + 2.6 * Math.sqrt(Math.max(0, significantWaveHeightMetres)), 2, 16)
}

/**
 * Rate of turn in degrees per minute, from a heading change over a time step.
 * Returns 0 for non-positive steps rather than an infinity.
 */
export function rateOfTurnDegPerMin(
  previousHeadingDegrees: number,
  currentHeadingDegrees: number,
  dtSeconds: number,
): number {
  if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) return 0
  const delta = normalizeDegrees180(currentHeadingDegrees - previousHeadingDegrees)
  return (delta / dtSeconds) * 60
}
