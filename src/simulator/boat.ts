/**
 * The simulated vessel.
 *
 * The boat has one honest state — where it is, where its bow points, how fast
 * it moves through the water — and everything an instrument could report is
 * derived from that plus the environment. In particular:
 *
 *   heading + leeway + STW  →  velocity through the water
 *   velocity through water + current  →  velocity over ground (COG/SOG)
 *   true wind + velocity over ground  →  apparent wind (AWS/AWA)
 *
 * Nothing is randomised twice: a gust raises AWS, heels the boat, adds leeway
 * and moves COG away from heading, all from the same underlying change.
 */

import {
  blendAngles,
  clamp,
  normalizeDegrees180,
  normalizeDegrees360,
  polarToVector,
  smoothingAlpha,
  vectorToPolar,
  type Vector2,
} from '../core/math.js'
import { OrnsteinUhlenbeck, Random } from '../core/random.js'
import type { Environment } from './environment.js'
import {
  advancePosition,
  apparentWind,
  groundTrackFromWaterTrack,
  heelFromWind,
  leewayDegrees,
  metresPerDegreeLatitude,
  metresPerDegreeLongitude,
  trueWindAngle,
  wrapLongitude,
  type ApparentWind,
  type GeoPosition,
} from './physics.js'
import { METRES_PER_NAUTICAL_MILE } from '../core/units.js'

export type Propulsion = 'sail' | 'motor' | 'anchored'

export interface AnchorSetup {
  /** Length of rode deployed, metres — sets the swinging radius. */
  rodeMeters: number
  /** How far the vessel sails about its anchor, degrees. */
  swingSigmaDegrees: number
  /** Seconds of memory in the swing (larger = slower, lazier swinging). */
  swingTimeConstantSeconds: number
}

export interface VesselSetup {
  propulsion: Propulsion
  position: GeoPosition
  headingDegrees: number
  /** Commanded speed through the water, knots (motoring), or the calibration point (sailing). */
  targetSpeedKnots: number
  speedSigmaKnots: number
  speedTimeConstantSeconds: number
  /** Yaw wander about the commanded heading, degrees. */
  headingWanderSigmaDegrees: number
  headingWanderTimeConstantSeconds: number
  /** Maximum sustained turn rate, degrees per second. */
  turnRateDegPerSecond: number
  /** Larger = stiffer boat = less heel for the same wind. */
  heelStiffness: number
  maxHeelDegrees: number
  leewayCoefficient: number
  /** Hull speed ceiling for the sailing polar, knots. */
  hullSpeedKnots: number
  /** Depth of the sounder transducer below the waterline, metres. */
  transducerOffsetMeters: number
  /** Height of the GNSS antenna above the waterline, metres. */
  antennaHeightMeters: number
  anchor?: AnchorSetup | undefined
}

export interface VesselSnapshot {
  position: GeoPosition
  altitudeMeters: number
  headingTrue: number
  cogDegrees: number
  sogKnots: number
  speedThroughWaterKnots: number
  heelDegrees: number
  pitchDegrees: number
  rateOfTurnDegPerMin: number
  leewayDegrees: number
  apparent: ApparentWind
  trueWindAngleDegrees: number
  logTotalNm: number
  logTripNm: number
}

/**
 * A very simple sailing polar: how much of the true wind the boat can convert
 * into boat speed at a given true wind angle. Peaks on a reach, poor upwind,
 * moderate on a run — the shape that makes tacks and gybes look right.
 */
export function polarEfficiency(trueWindAngleDegrees: number): number {
  const angle = Math.abs(((trueWindAngleDegrees + 180) % 360) - 180)
  if (angle < 28) return 0.05
  if (angle < 45) return 0.05 + ((angle - 28) / 17) * 0.45
  if (angle < 90) return 0.5 + ((angle - 45) / 45) * 0.35
  if (angle < 135) return 0.85 - ((angle - 90) / 45) * 0.1
  return 0.75 - ((angle - 135) / 45) * 0.3
}

/** Boat speed a sailing vessel could make in the given wind, before calibration. */
export function polarSpeedKnots(
  trueWindSpeedKnots: number,
  trueWindAngleDegrees: number,
  hullSpeedKnots: number,
): number {
  const potential = Math.max(0, trueWindSpeedKnots) * polarEfficiency(trueWindAngleDegrees)
  // Soft ceiling at hull speed rather than a hard clip, so gusts still register.
  return hullSpeedKnots * Math.tanh(potential / Math.max(0.5, hullSpeedKnots))
}

export class Boat {
  private setup: VesselSetup

  private readonly random: Random

  private position: GeoPosition

  private headingDegrees: number

  /** Steered course without the superimposed yaw wander. */
  private baseHeadingDegrees: number

  private commandedHeadingDegrees: number

  private speedThroughWaterKnots: number

  /**
   * The boat's underlying speed, without the sensor/sea noise term. Noise is
   * added to the *reported* value only — folding it back into the state would
   * turn a bounded jitter into an unbounded random walk.
   */
  private speedStateKnots: number

  private readonly yaw: OrnsteinUhlenbeck

  private readonly speedNoise: OrnsteinUhlenbeck

  private readonly swing: OrnsteinUhlenbeck

  private readonly rodeNoise: OrnsteinUhlenbeck

  private anchorPosition: GeoPosition

  /**
   * The vessel's actual offset from its anchor, in metres north/east. The swing
   * model produces a *target* offset; the boat follows it through a low-pass so
   * the resulting ground speed stays in the fraction-of-a-knot range a swinging
   * boat really makes, rather than tracking the noise of the random walk.
   */
  private anchorOffsetMeters: Vector2 | null = null

  private heelDegrees = 0

  /** Steady heel from wind pressure, without the wave-induced roll. */
  private heelStateDegrees = 0

  private pitchDegrees = 0

  private currentRateOfTurn = 0

  private currentLeeway = 0

  private cogDegrees: number

  private sogKnots = 0

  private polarScale = 1

  private logTotalNm = 0

  private logTripNm = 0

  /**
   * Low-passed heading used to derive rate of turn. Taking the raw tick-to-tick
   * heading difference would report the yaw wander as a turn of hundreds of
   * degrees per minute; a real rate-of-turn sensor is damped, and so is this.
   */
  private rateOfTurnReferenceHeading: number

  constructor(setup: VesselSetup, random: Random) {
    this.setup = setup
    this.random = random
    this.position = { ...setup.position }
    this.anchorPosition = { ...setup.position }
    this.headingDegrees = normalizeDegrees360(setup.headingDegrees)
    this.baseHeadingDegrees = this.headingDegrees
    this.rateOfTurnReferenceHeading = this.headingDegrees
    this.commandedHeadingDegrees = this.headingDegrees
    this.cogDegrees = this.headingDegrees
    this.speedThroughWaterKnots = Math.max(0, setup.targetSpeedKnots)
    this.speedStateKnots = this.speedThroughWaterKnots

    this.yaw = new OrnsteinUhlenbeck(random.derive('yaw'), {
      mean: 0,
      sigma: setup.headingWanderSigmaDegrees,
      timeConstantSeconds: setup.headingWanderTimeConstantSeconds,
    })
    this.speedNoise = new OrnsteinUhlenbeck(random.derive('speed'), {
      mean: 0,
      sigma: setup.speedSigmaKnots,
      timeConstantSeconds: setup.speedTimeConstantSeconds,
    })
    this.swing = new OrnsteinUhlenbeck(random.derive('anchor-swing'), {
      mean: 0,
      sigma: setup.anchor?.swingSigmaDegrees ?? 25,
      timeConstantSeconds: setup.anchor?.swingTimeConstantSeconds ?? 45,
    })
    this.rodeNoise = new OrnsteinUhlenbeck(random.derive('anchor-rode'), {
      mean: 0,
      sigma: 0.12,
      timeConstantSeconds: 60,
    })
  }

  /**
   * Calibrate the sailing polar so the scenario's stated starting boat speed is
   * what the boat actually makes in its stated starting wind. Wind changes then
   * move the boat speed correctly around that operating point.
   */
  calibratePolar(nominalWindSpeedKnots: number, nominalTrueWindAngleDegrees: number): void {
    const reference = polarSpeedKnots(nominalWindSpeedKnots, nominalTrueWindAngleDegrees, this.setup.hullSpeedKnots)
    this.polarScale = reference > 0.2 ? this.setup.targetSpeedKnots / reference : 1
  }

  reconfigure(setup: VesselSetup, options: { keepPosition?: boolean } = {}): void {
    const previousPosition = this.position
    this.setup = setup
    this.position = options.keepPosition ? previousPosition : { ...setup.position }
    this.anchorPosition = { ...this.position }
    this.anchorOffsetMeters = null
    this.headingDegrees = normalizeDegrees360(setup.headingDegrees)
    this.baseHeadingDegrees = this.headingDegrees
    this.rateOfTurnReferenceHeading = this.headingDegrees
    this.commandedHeadingDegrees = this.headingDegrees
    this.cogDegrees = this.headingDegrees
    this.speedThroughWaterKnots = Math.max(0, setup.targetSpeedKnots)
    this.speedStateKnots = this.speedThroughWaterKnots
    this.heelDegrees = 0
    this.heelStateDegrees = 0
    this.pitchDegrees = 0
    this.currentRateOfTurn = 0
    this.currentLeeway = 0
    this.logTripNm = 0
    this.yaw.configure({ sigma: setup.headingWanderSigmaDegrees, timeConstantSeconds: setup.headingWanderTimeConstantSeconds })
    this.speedNoise.configure({ sigma: setup.speedSigmaKnots, timeConstantSeconds: setup.speedTimeConstantSeconds })
    this.swing.configure({
      sigma: setup.anchor?.swingSigmaDegrees ?? 25,
      timeConstantSeconds: setup.anchor?.swingTimeConstantSeconds ?? 45,
    })
  }

  get propulsion(): Propulsion {
    return this.setup.propulsion
  }

  get commandedHeading(): number {
    return this.commandedHeadingDegrees
  }

  /** Order a new course. The boat turns towards it at its own turn rate. */
  steerTo(headingDegrees: number): void {
    this.commandedHeadingDegrees = normalizeDegrees360(headingDegrees)
  }

  /** Order a new speed through the water. */
  setTargetSpeed(knots: number): void {
    this.setup = { ...this.setup, targetSpeedKnots: clamp(knots, 0, 80) }
  }

  get targetSpeedKnots(): number {
    return this.setup.targetSpeedKnots
  }

  get transducerOffsetMeters(): number {
    return this.setup.transducerOffsetMeters
  }

  get antennaHeightMeters(): number {
    return this.setup.antennaHeightMeters
  }

  get currentPosition(): GeoPosition {
    return { ...this.position }
  }

  setPosition(position: GeoPosition): void {
    this.position = {
      latitude: clamp(position.latitude, -89.9, 89.9),
      longitude: wrapLongitude(position.longitude),
    }
    this.anchorPosition = { ...this.position }
    this.anchorOffsetMeters = null
  }

  setHeading(headingDegrees: number): void {
    this.headingDegrees = normalizeDegrees360(headingDegrees)
    this.baseHeadingDegrees = this.headingDegrees
    this.rateOfTurnReferenceHeading = this.headingDegrees
    this.commandedHeadingDegrees = this.headingDegrees
  }

  setSpeedThroughWater(knots: number): void {
    this.speedThroughWaterKnots = clamp(knots, 0, 80)
    this.speedStateKnots = this.speedThroughWaterKnots
    this.setTargetSpeed(this.speedThroughWaterKnots)
  }

  resetTripLog(): void {
    this.logTripNm = 0
  }

  /** Advance the vessel by `dtSeconds` inside `environment`. */
  step(dtSeconds: number, environment: Environment): VesselSnapshot {
    const dt = Math.max(0, dtSeconds)
    this.yaw.step(dt)
    this.speedNoise.step(dt)
    this.swing.step(dt)
    this.rodeNoise.step(dt)

    const trueWindDirection = environment.trueWindDirectionDegrees
    const trueWindSpeed = environment.trueWindSpeedKnots

    if (this.setup.propulsion === 'anchored') {
      this.stepAtAnchor(dt, environment, trueWindDirection)
    } else {
      this.stepUnderway(dt, environment, trueWindDirection, trueWindSpeed)
    }

    this.currentRateOfTurn = this.updateRateOfTurn(dt)

    const apparent = apparentWind(
      trueWindDirection,
      trueWindSpeed,
      this.headingDegrees,
      this.sogKnots,
      this.cogDegrees,
    )

    this.updateAttitude(dt, environment, apparent)

    const distanceNm = (this.speedThroughWaterKnots * dt) / 3600
    this.logTotalNm += distanceNm
    this.logTripNm += distanceNm

    return {
      position: { ...this.position },
      // GNSS antenna height above the geoid; the simulator sails at sea level.
      altitudeMeters: this.setup.antennaHeightMeters + environment.waveState.heaveMeters,
      headingTrue: this.headingDegrees,
      cogDegrees: this.cogDegrees,
      sogKnots: this.sogKnots,
      speedThroughWaterKnots: this.speedThroughWaterKnots,
      heelDegrees: this.heelDegrees,
      pitchDegrees: this.pitchDegrees,
      rateOfTurnDegPerMin: this.currentRateOfTurn,
      leewayDegrees: this.currentLeeway,
      apparent,
      trueWindAngleDegrees: trueWindAngle(trueWindDirection, this.headingDegrees),
      logTotalNm: this.logTotalNm,
      logTripNm: this.logTripNm,
    }
  }

  private stepUnderway(
    dtSeconds: number,
    environment: Environment,
    trueWindDirection: number,
    trueWindSpeed: number,
  ): void {
    // 1. Steering: turn towards the commanded heading, then add yaw wander.
    const maxTurn = this.setup.turnRateDegPerSecond * dtSeconds
    this.baseHeadingDegrees = approachWithRate(this.baseHeadingDegrees, this.commandedHeadingDegrees, maxTurn)
    this.headingDegrees = normalizeDegrees360(this.baseHeadingDegrees + this.yaw.value)

    // 2. Speed through the water.
    const twa = trueWindAngle(trueWindDirection, this.headingDegrees)
    const target =
      this.setup.propulsion === 'sail'
        ? clamp(polarSpeedKnots(trueWindSpeed, twa, this.setup.hullSpeedKnots) * this.polarScale, 0, this.setup.hullSpeedKnots * 1.4)
        : this.setup.targetSpeedKnots
    // Boats have mass: speed changes are smoothed, never stepped.
    const responseSeconds = this.setup.propulsion === 'sail' ? 12 : 8
    const alpha = smoothingAlpha(dtSeconds, responseSeconds)
    this.speedStateKnots = Math.max(0, this.speedStateKnots + (target - this.speedStateKnots) * alpha)
    this.speedThroughWaterKnots = Math.max(0, this.speedStateKnots + this.speedNoise.value)

    // 3. Leeway, then the water track, then the ground track via the current.
    this.currentLeeway =
      this.setup.propulsion === 'sail'
        ? leewayDegrees(twa, this.heelDegrees, this.speedThroughWaterKnots, this.setup.leewayCoefficient)
        : 0
    const waterTrack = normalizeDegrees360(this.headingDegrees + this.currentLeeway)
    const ground = groundTrackFromWaterTrack(
      waterTrack,
      this.speedThroughWaterKnots,
      environment.currentSetDegrees,
      environment.currentDriftKnots,
    )
    this.cogDegrees = ground.cogDegrees
    this.sogKnots = ground.sogKnots

    // 4. Integrate the position along the ground track.
    this.position = advancePosition(this.position, this.cogDegrees, this.sogKnots, dtSeconds)
  }

  private stepAtAnchor(dtSeconds: number, environment: Environment, trueWindDirection: number): void {
    const anchor = this.setup.anchor
    const rodeMeters = Math.max(5, anchor?.rodeMeters ?? 40)
    // The vessel lies downwind of its anchor, sailing to and fro about that line.
    const lieBearing = normalizeDegrees360(trueWindDirection + 180 + this.swing.value)
    const radiusMeters = rodeMeters * clamp(0.85 + this.rodeNoise.value, 0.5, 1.05)

    const targetOffset = polarToVector(lieBearing, radiusMeters)
    if (this.anchorOffsetMeters === null) this.anchorOffsetMeters = targetOffset
    const follow = smoothingAlpha(dtSeconds, 45)
    this.anchorOffsetMeters = {
      north: this.anchorOffsetMeters.north + (targetOffset.north - this.anchorOffsetMeters.north) * follow,
      east: this.anchorOffsetMeters.east + (targetOffset.east - this.anchorOffsetMeters.east) * follow,
    }

    const offset = this.anchorOffsetMeters
    const previous = this.position
    this.position = {
      latitude: this.anchorPosition.latitude + offset.north / metresPerDegreeLatitude(this.anchorPosition.latitude),
      longitude: wrapLongitude(
        this.anchorPosition.longitude +
          offset.east / Math.max(1e-6, metresPerDegreeLongitude(this.anchorPosition.latitude)),
      ),
    }

    // Ground velocity is whatever the swing actually produced.
    const northMetres = (this.position.latitude - previous.latitude) * metresPerDegreeLatitude(previous.latitude)
    const eastMetres = (this.position.longitude - previous.longitude) * metresPerDegreeLongitude(previous.latitude)
    const groundVector = dtSeconds > 0
      ? {
          north: (northMetres / dtSeconds / METRES_PER_NAUTICAL_MILE) * 3600,
          east: (eastMetres / dtSeconds / METRES_PER_NAUTICAL_MILE) * 3600,
        }
      : { north: 0, east: 0 }
    const groundPolar = vectorToPolar(groundVector)
    this.sogKnots = clamp(groundPolar.magnitude, 0, 3)
    this.cogDegrees = groundPolar.magnitude < 0.02 ? this.cogDegrees : groundPolar.directionDegrees

    // The bow lies into the combined wind and current; heading is not a course.
    const currentBearing = normalizeDegrees360(environment.currentSetDegrees + 180)
    const currentWeight = clamp(environment.currentDriftKnots / Math.max(0.5, environment.trueWindSpeedKnots * 0.3), 0, 0.6)
    const lie = blendAngles(trueWindDirection, currentBearing, currentWeight)
    const targetHeading = normalizeDegrees360(lie + this.swing.value * 0.85)
    this.baseHeadingDegrees = blendAngles(this.baseHeadingDegrees, targetHeading, smoothingAlpha(dtSeconds, 8))
    this.headingDegrees = this.baseHeadingDegrees
    this.commandedHeadingDegrees = this.headingDegrees

    // At anchor the water still flows past the hull: STW reads the current.
    const current = polarToVector(environment.currentSetDegrees, environment.currentDriftKnots)
    const throughWater = vectorToPolar({
      north: groundVector.north - current.north,
      east: groundVector.east - current.east,
    })
    this.speedThroughWaterKnots = clamp(throughWater.magnitude, 0, 6)
    this.currentLeeway = 0
  }

  /**
   * Rate of turn, in degrees per minute, from the movement of a low-passed
   * heading. A sustained turn tracks correctly (with a short lag); yaw wander
   * shows as the small oscillating rate a real vessel actually has.
   */
  private updateRateOfTurn(dtSeconds: number): number {
    if (dtSeconds <= 0) return this.currentRateOfTurn
    const alpha = smoothingAlpha(dtSeconds, 5)
    const error = normalizeDegrees180(this.headingDegrees - this.rateOfTurnReferenceHeading)
    const step = error * alpha
    this.rateOfTurnReferenceHeading = normalizeDegrees360(this.rateOfTurnReferenceHeading + step)
    return clamp((step / dtSeconds) * 60, -600, 600)
  }

  private updateAttitude(dtSeconds: number, environment: Environment, apparent: ApparentWind): void {
    const waves = environment.waveState
    const windHeel =
      this.setup.propulsion === 'sail'
        ? heelFromWind(apparent.angleDegrees, apparent.speedKnots, this.setup.heelStiffness, this.setup.maxHeelDegrees)
        : heelFromWind(apparent.angleDegrees, apparent.speedKnots, this.setup.heelStiffness * 4, this.setup.maxHeelDegrees / 2)

    // Heel has inertia; it lags the gust that caused it. As with speed, the
    // wave-induced roll rides on top of the steady heel rather than being fed
    // back into it.
    const alpha = smoothingAlpha(dtSeconds, 3.5)
    this.heelStateDegrees += (windHeel - this.heelStateDegrees) * alpha
    this.heelDegrees = clamp(
      this.heelStateDegrees + waves.rollDegrees * 0.35,
      -this.setup.maxHeelDegrees - 12,
      this.setup.maxHeelDegrees + 12,
    )

    const trim = this.setup.propulsion === 'motor' ? clamp(this.speedThroughWaterKnots / 12, 0, 2.5) : 0
    this.pitchDegrees = clamp(waves.pitchDegrees + trim + this.random.gaussian(0, 0.05), -25, 25)
  }
}

/** Turn from `from` towards `to`, limited to `maxStep` degrees. */
function approachWithRate(from: number, to: number, maxStep: number): number {
  const delta = ((to - from + 540) % 360) - 180
  const step = clamp(delta, -Math.abs(maxStep), Math.abs(maxStep))
  return normalizeDegrees360(from + step)
}
