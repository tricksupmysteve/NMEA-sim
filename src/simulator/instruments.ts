/**
 * Instruments sit between the canonical vessel state and the protocol encoders.
 *
 * This indirection is the whole point of the simulator as a Matey test rig:
 *
 *  - each instrument samples at its own rate, so consumers see genuinely
 *    different data ages ("wind 120 ms ago, GPS 840 ms ago");
 *  - each instrument can be disabled, frozen, taken offline or marked invalid
 *    independently, which is how the sensor-failure scenario works;
 *  - encoders read *instrument snapshots*, never live state, so a frozen
 *    heading really does keep transmitting its last value.
 */

import { clamp, normalizeDegrees360 } from '../core/math.js'
import { OrnsteinUhlenbeck, Random } from '../core/random.js'
import type { InstrumentId } from '../types.js'

/** How an instrument is currently misbehaving. */
export type ChannelFault =
  /** Working normally. */
  | 'none'
  /** Still transmitting, but the value stopped changing (stale data). */
  | 'frozen'
  /** Transmitting nothing at all — the sentence disappears from the stream. */
  | 'offline'
  /** Still transmitting, but flagged invalid (RMC status V, MWV status V, fix 0). */
  | 'invalid'

export const CHANNEL_FAULTS: readonly ChannelFault[] = ['none', 'frozen', 'offline', 'invalid']

export function isChannelFault(value: string): value is ChannelFault {
  return (CHANNEL_FAULTS as readonly string[]).includes(value)
}

export interface SatelliteInfo {
  prn: number
  elevationDegrees: number
  azimuthDegrees: number
  signalToNoiseDb: number
  used: boolean
}

export interface GpsSample {
  /** UTC of the fix, as reported by the receiver. */
  time: Date
  latitude: number
  longitude: number
  altitudeMeters: number
  geoidSeparationMeters: number
  /** GGA fix quality: 0 invalid, 1 GPS, 2 DGPS. */
  fixQuality: number
  satellitesUsed: number
  hdop: number
  pdop: number
  vdop: number
  cogDegrees: number
  sogKnots: number
  satellites: SatelliteInfo[]
}

export interface HeadingSample {
  headingTrue: number
  headingMagnetic: number
  /** Positive east. */
  variationDegrees: number
  /** Positive east. */
  deviationDegrees: number
  rateOfTurnDegPerMin: number
}

export interface WindSample {
  /** Relative to the bow, 0-360 clockwise. */
  apparentAngleDegrees: number
  apparentSpeedKnots: number
  /** Relative to the bow, 0-360 clockwise. */
  trueAngleDegrees: number
  /** Compass direction the true wind blows from. */
  trueDirectionDegrees: number
  trueSpeedKnots: number
}

export interface DepthSample {
  depthBelowTransducerMeters: number
  /** Transducer depth below the waterline, metres (positive). */
  offsetMeters: number
  depthBelowSurfaceMeters: number
}

export interface WaterSpeedSample {
  speedThroughWaterKnots: number
  headingTrue: number
  headingMagnetic: number
  logTotalNm: number
  logTripNm: number
}

export interface TemperatureSample {
  waterTemperatureC: number
}

export interface PressureSample {
  airPressureHpa: number
  airTemperatureC: number
  relativeHumidityPercent: number
}

export interface AttitudeSample {
  heelDegrees: number
  pitchDegrees: number
  rateOfTurnDegPerMin: number
}

export interface AisTargetSample {
  mmsi: number
  name: string
  latitude: number
  longitude: number
  cogDegrees: number
  sogKnots: number
  headingTrue: number
  rateOfTurnDegPerMin: number
  navigationStatus: number
}

export interface AisSample {
  own: AisTargetSample
  targets: AisTargetSample[]
}

/** One sensor's latest reading plus the metadata Matey needs to judge it. */
export class InstrumentChannel<T> {
  private latest: T | null = null

  private lastUpdatedAtMs: number | null = null

  private updateCount = 0

  fault: ChannelFault = 'none'

  enabled: boolean

  constructor(
    readonly id: InstrumentId,
    public sampleIntervalMs: number,
    enabled = true,
  ) {
    this.enabled = enabled
  }

  /** Offer a new reading. Ignored while the channel is disabled or frozen. */
  update(value: T, atMs: number): void {
    if (!this.enabled) return
    if (this.fault === 'frozen') return
    this.latest = value
    this.lastUpdatedAtMs = atMs
    this.updateCount += 1
  }

  /** Force a value in regardless of fault state (used by `PATCH /state`). */
  force(value: T, atMs: number): void {
    this.latest = value
    this.lastUpdatedAtMs = atMs
    this.updateCount += 1
  }

  get value(): T | null {
    return this.latest
  }

  /** True when this channel should contribute sentences to the stream. */
  get available(): boolean {
    return this.enabled && this.fault !== 'offline' && this.latest !== null
  }

  /** False when the data should be transmitted but flagged as not valid. */
  get valid(): boolean {
    return this.fault !== 'invalid'
  }

  get updatedAtMs(): number | null {
    return this.lastUpdatedAtMs
  }

  get updates(): number {
    return this.updateCount
  }

  ageMs(nowMs: number): number | null {
    return this.lastUpdatedAtMs === null ? null : Math.max(0, nowMs - this.lastUpdatedAtMs)
  }

  clear(): void {
    this.latest = null
    this.lastUpdatedAtMs = null
  }

  status(nowMs: number): InstrumentStatus {
    return {
      id: this.id,
      enabled: this.enabled,
      fault: this.fault,
      available: this.available,
      valid: this.valid,
      sampleIntervalMs: this.sampleIntervalMs,
      sampleRateHz: this.sampleIntervalMs > 0 ? Number((1000 / this.sampleIntervalMs).toFixed(3)) : 0,
      updates: this.updateCount,
      updatedAt: this.lastUpdatedAtMs === null ? null : new Date(this.lastUpdatedAtMs).toISOString(),
      ageMs: this.ageMs(nowMs),
    }
  }
}

export interface InstrumentStatus {
  id: InstrumentId
  enabled: boolean
  fault: ChannelFault
  available: boolean
  valid: boolean
  sampleIntervalMs: number
  sampleRateHz: number
  updates: number
  updatedAt: string | null
  ageMs: number | null
}

/** The full instrument set. */
export interface InstrumentChannels {
  gps: InstrumentChannel<GpsSample>
  heading: InstrumentChannel<HeadingSample>
  wind: InstrumentChannel<WindSample>
  depth: InstrumentChannel<DepthSample>
  waterSpeed: InstrumentChannel<WaterSpeedSample>
  temperature: InstrumentChannel<TemperatureSample>
  pressure: InstrumentChannel<PressureSample>
  attitude: InstrumentChannel<AttitudeSample>
  ais: InstrumentChannel<AisSample>
}

export type InstrumentIntervals = Record<InstrumentId, number>
export type InstrumentToggles = Record<InstrumentId, boolean>

export function createInstrumentChannels(
  intervals: InstrumentIntervals,
  enabled: InstrumentToggles,
): InstrumentChannels {
  return {
    gps: new InstrumentChannel<GpsSample>('gps', intervals.gps, enabled.gps),
    heading: new InstrumentChannel<HeadingSample>('heading', intervals.heading, enabled.heading),
    wind: new InstrumentChannel<WindSample>('wind', intervals.wind, enabled.wind),
    depth: new InstrumentChannel<DepthSample>('depth', intervals.depth, enabled.depth),
    waterSpeed: new InstrumentChannel<WaterSpeedSample>('waterSpeed', intervals.waterSpeed, enabled.waterSpeed),
    temperature: new InstrumentChannel<TemperatureSample>('temperature', intervals.temperature, enabled.temperature),
    pressure: new InstrumentChannel<PressureSample>('pressure', intervals.pressure, enabled.pressure),
    attitude: new InstrumentChannel<AttitudeSample>('attitude', intervals.attitude, enabled.attitude),
    ais: new InstrumentChannel<AisSample>('ais', intervals.ais, enabled.ais),
  }
}

export function channelList(channels: InstrumentChannels): Array<InstrumentChannel<unknown>> {
  return Object.values(channels) as Array<InstrumentChannel<unknown>>
}

/**
 * A plausible GNSS receiver: a slowly-changing constellation, correlated
 * dilution-of-precision figures, and metre-scale position noise on top of the
 * vessel's true position. The noise is what produces the small GPS wander seen
 * at anchor — it is a receiver artefact, not the boat moving.
 */
export class GnssModel {
  private readonly satellites: SatelliteInfo[] = []

  private readonly latitudeNoise: OrnsteinUhlenbeck

  private readonly longitudeNoise: OrnsteinUhlenbeck

  private readonly altitudeNoise: OrnsteinUhlenbeck

  private readonly random: Random

  private elapsedSeconds = 0

  constructor(random: Random, private accuracyMeters = 2.5) {
    this.random = random
    const noiseOptions = { mean: 0, sigma: 1, timeConstantSeconds: 25 }
    this.latitudeNoise = new OrnsteinUhlenbeck(random.derive('gnss-lat'), noiseOptions)
    this.longitudeNoise = new OrnsteinUhlenbeck(random.derive('gnss-lon'), noiseOptions)
    this.altitudeNoise = new OrnsteinUhlenbeck(random.derive('gnss-alt'), { mean: 0, sigma: 1, timeConstantSeconds: 40 })

    // A twelve-satellite view is typical for a marine antenna with a clear sky.
    const count = random.integer(9, 12)
    for (let index = 0; index < count; index += 1) {
      this.satellites.push({
        prn: random.integer(1, 32),
        elevationDegrees: random.integer(8, 85),
        azimuthDegrees: random.integer(0, 359),
        signalToNoiseDb: random.integer(28, 50),
        used: true,
      })
    }
    // Deduplicate PRNs so the GSV output is realistic.
    const seen = new Set<number>()
    for (const satellite of this.satellites) {
      while (seen.has(satellite.prn)) satellite.prn = (satellite.prn % 32) + 1
      seen.add(satellite.prn)
    }
    this.satellites.sort((a, b) => a.prn - b.prn)
  }

  setAccuracy(meters: number): void {
    this.accuracyMeters = clamp(meters, 0, 200)
  }

  step(dtSeconds: number): void {
    this.elapsedSeconds += Math.max(0, dtSeconds)
    this.latitudeNoise.step(dtSeconds)
    this.longitudeNoise.step(dtSeconds)
    this.altitudeNoise.step(dtSeconds)

    // Satellites drift across the sky; SNR breathes a little.
    for (const satellite of this.satellites) {
      satellite.elevationDegrees = clamp(
        satellite.elevationDegrees + this.random.gaussian(0, 0.02) * dtSeconds,
        3,
        89,
      )
      satellite.azimuthDegrees = normalizeDegrees360(satellite.azimuthDegrees + 0.004 * dtSeconds * 60)
      satellite.signalToNoiseDb = clamp(satellite.signalToNoiseDb + this.random.gaussian(0, 0.08), 18, 54)
      satellite.used = satellite.elevationDegrees > 7
    }
  }

  /** Metre-scale position error, in metres north and east. */
  get positionErrorMeters(): { north: number; east: number; up: number } {
    return {
      north: this.latitudeNoise.value * this.accuracyMeters,
      east: this.longitudeNoise.value * this.accuracyMeters,
      up: this.altitudeNoise.value * this.accuracyMeters * 1.6,
    }
  }

  get satellitesInView(): SatelliteInfo[] {
    return this.satellites
  }

  get satellitesUsed(): number {
    return this.satellites.filter((satellite) => satellite.used).length
  }

  /** Dilution of precision, loosely tied to how many satellites are usable. */
  get dop(): { hdop: number; vdop: number; pdop: number } {
    const used = Math.max(3, this.satellitesUsed)
    const hdop = clamp(6.5 / used + 0.15 * Math.sin(this.elapsedSeconds / 90), 0.5, 9.9)
    const vdop = clamp(hdop * 1.55, 0.6, 20)
    return { hdop, vdop, pdop: clamp(Math.hypot(hdop, vdop), 0.6, 25) }
  }

  /** Height of the geoid above the WGS84 ellipsoid — regional, roughly constant. */
  get geoidSeparationMeters(): number {
    return 34.2
  }
}
