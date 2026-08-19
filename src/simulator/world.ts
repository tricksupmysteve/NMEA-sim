/**
 * The world: one environment, one vessel, one set of instruments, one fault
 * controller — and one canonical `BoatState` derived from all of it.
 *
 * Everything downstream (NMEA 0183 today, NMEA 2000 / Signal K / UDP later)
 * reads from here and nowhere else.
 */

import { clamp, normalizeDegrees360 } from '../core/math.js'
import { Random } from '../core/random.js'
import type { BoatState, BoatStatePatch, InstrumentId } from '../types.js'
import { Boat, type VesselSetup } from './boat.js'
import { Environment, type EnvironmentSetup } from './environment.js'
import { FaultController, type FaultLogEntry, type FaultTimeline } from './faults.js'
import {
  GnssModel,
  createInstrumentChannels,
  type InstrumentChannels,
  type InstrumentIntervals,
  type InstrumentStatus,
  type InstrumentToggles,
} from './instruments.js'
import {
  metresPerDegreeLatitude,
  metresPerDegreeLongitude,
  wrapLongitude,
  type GeoPosition,
} from './physics.js'
import { AisTraffic } from './traffic.js'

export interface OwnShipIdentity {
  mmsi: number
  name: string
  callSign: string
  /** AIS ship-and-cargo type; 36 = sailing, 37 = pleasure craft. */
  shipType: number
}

export interface WorldSetup {
  vessel: VesselSetup
  environment: EnvironmentSetup
  /** Calibration point for the sailing polar: the wind the scenario starts in. */
  nominalTrueWindSpeedKnots: number
  aisTargetCount: number
}

export interface WorldOptions {
  seed: number
  /** Positive east, degrees. */
  magneticVariationDegrees: number
  /** Compass deviation, degrees positive east. */
  compassDeviationDegrees: number
  instrumentIntervals: InstrumentIntervals
  instrumentEnabled: InstrumentToggles
  ownShip: OwnShipIdentity
  gnssAccuracyMeters: number
}

export class World {
  readonly channels: InstrumentChannels

  readonly faults: FaultController

  private environment: Environment

  private boat: Boat

  private gnss: GnssModel

  private traffic: AisTraffic

  private setup: WorldSetup

  private readonly random: Random

  private elapsedSeconds = 0

  private state: BoatState

  private lastPhysicsMs: number | null = null

  constructor(
    setup: WorldSetup,
    private options: WorldOptions,
    startEpochMs: number,
    onFaultEvent: (entry: FaultLogEntry) => void = () => {},
  ) {
    this.setup = setup
    this.random = new Random(options.seed, 'world')
    this.environment = new Environment(setup.environment, this.random.derive('environment'))
    this.boat = new Boat(setup.vessel, this.random.derive('boat'))
    this.boat.calibratePolar(
      setup.nominalTrueWindSpeedKnots,
      normalizeDegrees360(setup.environment.wind.directionDegrees - setup.vessel.headingDegrees),
    )
    this.gnss = new GnssModel(this.random.derive('gnss'), options.gnssAccuracyMeters)
    this.traffic = new AisTraffic(setup.vessel.position, setup.aisTargetCount, this.random.derive('traffic'))
    this.channels = createInstrumentChannels(options.instrumentIntervals, options.instrumentEnabled)
    this.faults = new FaultController(this.channels, this.random.derive('faults'), onFaultEvent)

    // Prime the environment and vessel so the very first sentence is sane.
    this.environment.step(0)
    this.environment.trueWindSpeedKnots = setup.environment.wind.speedKnots
    this.state = this.buildState(startEpochMs, this.boat.step(0, this.environment))
  }

  /** Swap in a new scenario without restarting the process. */
  reconfigure(setup: WorldSetup, faultTimeline: FaultTimeline | undefined, nowMs: number): void {
    this.setup = setup
    this.environment.reconfigure(setup.environment)
    this.environment.trueWindSpeedKnots = setup.environment.wind.speedKnots
    this.boat.reconfigure(setup.vessel)
    this.boat.calibratePolar(
      setup.nominalTrueWindSpeedKnots,
      normalizeDegrees360(setup.environment.wind.directionDegrees - setup.vessel.headingDegrees),
    )
    this.traffic = new AisTraffic(setup.vessel.position, setup.aisTargetCount, this.random.derive('traffic'))
    this.faults.setTimeline(faultTimeline)
    this.elapsedSeconds = 0
    this.lastPhysicsMs = null
    this.state = this.buildState(nowMs, this.boat.step(0, this.environment))
    this.sampleAll(nowMs)
  }

  get currentSetup(): WorldSetup {
    return this.setup
  }

  get boatState(): BoatState {
    return this.state
  }

  get vessel(): Boat {
    return this.boat
  }

  get world(): Environment {
    return this.environment
  }

  get elapsed(): number {
    return this.elapsedSeconds
  }

  get aisTargetCount(): number {
    return this.traffic.count
  }

  /** Advance physics to `nowMs`. Safe to call at any rate. */
  stepPhysics(nowMs: number): void {
    const dtSeconds = this.lastPhysicsMs === null ? 0 : Math.max(0, (nowMs - this.lastPhysicsMs) / 1000)
    this.lastPhysicsMs = nowMs
    // Guard against a huge step after a pause: clamp rather than teleport.
    const dt = Math.min(dtSeconds, 5)
    this.elapsedSeconds += dt

    this.environment.step(dt)
    const snapshot = this.boat.step(dt, this.environment)
    this.gnss.step(dt)
    this.traffic.step(dt)
    this.faults.update(this.elapsedSeconds)
    this.state = this.buildState(nowMs, snapshot)
  }

  /** Take a fresh reading for one instrument. Called at each sensor's own rate. */
  sample(instrument: InstrumentId, atMs: number): void {
    const state = this.state
    switch (instrument) {
      case 'gps': {
        const error = this.gnss.positionErrorMeters
        const latitude = clamp(
          state.position.latitude + error.north / metresPerDegreeLatitude(state.position.latitude),
          -89.9,
          89.9,
        )
        const longitude = wrapLongitude(
          state.position.longitude + error.east / Math.max(1e-6, metresPerDegreeLongitude(state.position.latitude)),
        )
        const dop = this.gnss.dop
        const invalid = this.channels.gps.fault === 'invalid'
        this.channels.gps.update(
          {
            time: new Date(atMs),
            latitude,
            longitude,
            altitudeMeters: (state.position.altitude ?? 0) + error.up,
            geoidSeparationMeters: this.gnss.geoidSeparationMeters,
            fixQuality: invalid ? 0 : 1,
            satellitesUsed: invalid ? 0 : this.gnss.satellitesUsed,
            hdop: dop.hdop,
            pdop: dop.pdop,
            vdop: dop.vdop,
            cogDegrees: state.navigation.cog,
            sogKnots: state.navigation.sogKnots,
            satellites: this.gnss.satellitesInView.map((satellite) => ({ ...satellite })),
          },
          atMs,
        )
        break
      }
      case 'heading':
        this.channels.heading.update(
          {
            headingTrue: state.navigation.headingTrue,
            headingMagnetic: state.navigation.headingMagnetic ?? state.navigation.headingTrue,
            variationDegrees: this.options.magneticVariationDegrees,
            deviationDegrees: this.options.compassDeviationDegrees,
            rateOfTurnDegPerMin: state.extended.rateOfTurnDegPerMin,
          },
          atMs,
        )
        break
      case 'wind':
        this.channels.wind.update(
          {
            apparentAngleDegrees: state.wind.apparentAngleDegrees,
            apparentSpeedKnots: state.wind.apparentSpeedKnots,
            trueAngleDegrees: state.extended.trueWindAngleDegrees,
            trueDirectionDegrees: state.wind.trueDirectionDegrees,
            trueSpeedKnots: state.wind.trueSpeedKnots,
          },
          atMs,
        )
        break
      case 'depth':
        this.channels.depth.update(
          {
            depthBelowTransducerMeters: state.extended.depthBelowTransducerMeters,
            offsetMeters: state.extended.transducerOffsetMeters,
            depthBelowSurfaceMeters: state.environment.depthMeters,
          },
          atMs,
        )
        break
      case 'waterSpeed':
        this.channels.waterSpeed.update(
          {
            speedThroughWaterKnots: state.navigation.speedThroughWaterKnots,
            headingTrue: state.navigation.headingTrue,
            headingMagnetic: state.navigation.headingMagnetic ?? state.navigation.headingTrue,
            logTotalNm: state.extended.logTotalNm,
            logTripNm: state.extended.logTripNm,
          },
          atMs,
        )
        break
      case 'temperature':
        this.channels.temperature.update({ waterTemperatureC: state.environment.waterTemperatureC }, atMs)
        break
      case 'pressure':
        this.channels.pressure.update(
          {
            airPressureHpa: state.environment.airPressureHpa ?? 1013.25,
            airTemperatureC: state.extended.airTemperatureC,
            relativeHumidityPercent: state.extended.relativeHumidityPercent,
          },
          atMs,
        )
        break
      case 'attitude':
        this.channels.attitude.update(
          {
            heelDegrees: state.motion.heelDegrees ?? 0,
            pitchDegrees: state.motion.pitchDegrees ?? 0,
            rateOfTurnDegPerMin: state.extended.rateOfTurnDegPerMin,
          },
          atMs,
        )
        break
      case 'ais':
        this.channels.ais.update(
          {
            own: {
              mmsi: this.options.ownShip.mmsi,
              name: this.options.ownShip.name,
              latitude: state.position.latitude,
              longitude: state.position.longitude,
              cogDegrees: state.navigation.cog,
              sogKnots: state.navigation.sogKnots,
              headingTrue: state.navigation.headingTrue,
              rateOfTurnDegPerMin: state.extended.rateOfTurnDegPerMin,
              navigationStatus: this.boat.propulsion === 'anchored' ? 1 : this.boat.propulsion === 'sail' ? 8 : 0,
            },
            targets: this.traffic.samples(),
          },
          atMs,
        )
        break
    }
  }

  sampleAll(atMs: number): void {
    for (const id of Object.keys(this.channels) as InstrumentId[]) {
      this.sample(id, atMs)
    }
  }

  instrumentStatus(nowMs: number): InstrumentStatus[] {
    return Object.values(this.channels).map((channel) => channel.status(nowMs))
  }

  /** Apply a validated partial state override from the control API. */
  applyPatch(patch: BoatStatePatch, nowMs: number): void {
    if (patch.position) {
      const current = this.boat.currentPosition
      const next: GeoPosition = {
        latitude: patch.position.latitude ?? current.latitude,
        longitude: patch.position.longitude ?? current.longitude,
      }
      if (patch.position.latitude !== undefined || patch.position.longitude !== undefined) {
        this.boat.setPosition(next)
      }
      if (patch.position.hdop !== undefined || patch.position.satellites !== undefined) {
        this.gnss.setAccuracy(patch.position.hdop !== undefined ? patch.position.hdop * 2 : this.options.gnssAccuracyMeters)
      }
    }
    if (patch.navigation) {
      if (patch.navigation.headingTrue !== undefined) this.boat.setHeading(patch.navigation.headingTrue)
      if (patch.navigation.cog !== undefined) this.boat.steerTo(patch.navigation.cog)
      if (patch.navigation.speedThroughWaterKnots !== undefined) {
        this.boat.setSpeedThroughWater(patch.navigation.speedThroughWaterKnots)
      }
      if (patch.navigation.sogKnots !== undefined && patch.navigation.speedThroughWaterKnots === undefined) {
        this.boat.setSpeedThroughWater(patch.navigation.sogKnots)
      }
    }
    if (patch.wind) {
      this.environment.setTrueWind({
        directionDegrees: patch.wind.trueDirectionDegrees,
        speedKnots: patch.wind.trueSpeedKnots,
      })
    }
    if (patch.environment) {
      if (patch.environment.depthMeters !== undefined) this.environment.setDepth(patch.environment.depthMeters)
      if (patch.environment.waterTemperatureC !== undefined) {
        this.environment.setWaterTemperature(patch.environment.waterTemperatureC)
      }
      if (patch.environment.airPressureHpa !== undefined) {
        this.environment.setAirPressure(patch.environment.airPressureHpa)
      }
    }
    if (patch.current) {
      this.environment.setCurrent({
        setDegrees: patch.current.setDegrees,
        driftKnots: patch.current.driftKnots,
      })
    }

    // Rebuild immediately so `GET /state` reflects the patch without waiting.
    this.state = this.buildState(nowMs, this.boat.step(0, this.environment))
    this.sampleAll(nowMs)
  }

  private buildState(nowMs: number, snapshot: ReturnType<Boat['step']>): BoatState {
    const variation = this.options.magneticVariationDegrees
    const depthBelowSurface = this.environment.depthBelowSurfaceMeters(snapshot.position)
    const transducerOffset = this.boat.transducerOffsetMeters
    const waves = this.environment.waveState

    return {
      timestamp: new Date(nowMs),
      position: {
        latitude: snapshot.position.latitude,
        longitude: snapshot.position.longitude,
        altitude: snapshot.altitudeMeters,
        fixQuality: this.channels.gps.fault === 'invalid' ? 0 : 1,
        satellites: this.gnss.satellitesUsed,
        hdop: this.gnss.dop.hdop,
      },
      navigation: {
        headingTrue: snapshot.headingTrue,
        headingMagnetic: normalizeDegrees360(snapshot.headingTrue - variation),
        cog: snapshot.cogDegrees,
        sogKnots: snapshot.sogKnots,
        speedThroughWaterKnots: snapshot.speedThroughWaterKnots,
      },
      wind: {
        trueDirectionDegrees: this.environment.trueWindDirectionDegrees,
        trueSpeedKnots: this.environment.trueWindSpeedKnots,
        apparentAngleDegrees: snapshot.apparent.angleDegrees,
        apparentSpeedKnots: snapshot.apparent.speedKnots,
      },
      environment: {
        depthMeters: depthBelowSurface,
        waterTemperatureC: this.environment.waterTemperatureC,
        airPressureHpa: this.environment.airPressureHpa,
      },
      motion: {
        heelDegrees: snapshot.heelDegrees,
        pitchDegrees: snapshot.pitchDegrees,
      },
      extended: {
        rateOfTurnDegPerMin: snapshot.rateOfTurnDegPerMin,
        magneticVariationDeg: variation,
        trueWindAngleDegrees: snapshot.trueWindAngleDegrees,
        leewayDegrees: snapshot.leewayDegrees,
        current: {
          setDegrees: this.environment.currentSetDegrees,
          driftKnots: this.environment.currentDriftKnots,
        },
        transducerOffsetMeters: transducerOffset,
        depthBelowTransducerMeters: Math.max(0.2, depthBelowSurface - transducerOffset),
        airTemperatureC: this.environment.airTemperatureC,
        relativeHumidityPercent: this.environment.relativeHumidityPercent,
        waveHeightMeters: waves.significantHeightMeters,
        logTotalNm: snapshot.logTotalNm,
        logTripNm: snapshot.logTripNm,
        elapsedSeconds: this.elapsedSeconds,
      },
    }
  }
}
