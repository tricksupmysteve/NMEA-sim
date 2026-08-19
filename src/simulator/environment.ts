/**
 * The world the vessel moves through: true wind, surface current, sea state,
 * water temperature, air pressure and the seabed.
 *
 * Nothing here knows about NMEA. The environment produces physical quantities;
 * the boat reacts to them; encoders read the result.
 */

import { clamp, normalizeDegrees360, smoothingAlpha } from '../core/math.js'
import { GustModel, OrnsteinUhlenbeck, Random, ValueNoise, hashString } from '../core/random.js'
import { significantWaveHeight, waveperiodSeconds } from './physics.js'
import type { GeoPosition } from './physics.js'

export interface WindSetup {
  /** Mean direction the true wind blows from, degrees true. */
  directionDegrees: number
  /** Typical wander of the wind direction, degrees. */
  directionSigmaDegrees: number
  /** Seconds of memory in the wind direction (larger = steadier). */
  directionTimeConstantSeconds: number
  /** Mean true wind speed, knots. */
  speedKnots: number
  /** Drift of the base wind speed, knots. */
  speedSigmaKnots: number
  /** Seconds of memory in the base wind speed. */
  speedTimeConstantSeconds: number
  /** Mean gust overshoot above the base wind, knots. */
  gustKnots: number
  /** Mean seconds between gusts. */
  gustIntervalSeconds: number
  /** Mean gust duration, seconds. */
  gustDurationSeconds: number
}

export interface CurrentSetup {
  /** Direction the current flows towards, degrees true. */
  setDegrees: number
  /** Current speed, knots. */
  driftKnots: number
  /** Wander of the current speed, knots. */
  driftSigmaKnots: number
}

export interface SeabedSetup {
  /** Mean depth of water below the surface, metres. */
  depthMeters: number
  /** Amplitude of the seabed contour variation, metres. */
  depthVariationMeters: number
  /** Nautical miles between major seabed features. */
  featureScaleNm: number
  /** Peak-to-peak tidal range, metres. */
  tideRangeMeters: number
  /** Tidal period, seconds (default is a semi-diurnal tide). */
  tidePeriodSeconds: number
}

export interface EnvironmentSetup {
  wind: WindSetup
  current: CurrentSetup
  seabed: SeabedSetup
  waterTemperatureC: number
  waterTemperatureSigmaC: number
  airTemperatureC: number
  airPressureHpa: number
  airPressureSigmaHpa: number
  relativeHumidityPercent: number
  /** 0 = flat sheltered water, 1 = open coastal, 2 = ocean swell. */
  fetchFactor: number
}

export interface WaveState {
  significantHeightMeters: number
  periodSeconds: number
  /** Instantaneous vertical displacement of the surface, metres. */
  heaveMeters: number
  /** Instantaneous roll contribution from waves, degrees. */
  rollDegrees: number
  /** Instantaneous pitch contribution from waves, degrees. */
  pitchDegrees: number
}

export class Environment {
  private setup: EnvironmentSetup

  private readonly random: Random

  private readonly windDirection: OrnsteinUhlenbeck

  private readonly windSpeed: GustModel

  private readonly currentDrift: OrnsteinUhlenbeck

  private readonly currentSet: OrnsteinUhlenbeck

  private readonly waterTemperature: OrnsteinUhlenbeck

  private readonly airTemperature: OrnsteinUhlenbeck

  private readonly airPressure: OrnsteinUhlenbeck

  private readonly humidity: OrnsteinUhlenbeck

  private readonly seabedNoise: ValueNoise

  private readonly depthNoise: OrnsteinUhlenbeck

  private wavePhase = 0

  private pitchPhase = 0

  private waves: WaveState = {
    significantHeightMeters: 0,
    periodSeconds: 5,
    heaveMeters: 0,
    rollDegrees: 0,
    pitchDegrees: 0,
  }

  /** Seconds of simulated time this environment has been running. */
  private elapsedSeconds = 0

  constructor(setup: EnvironmentSetup, random: Random) {
    this.setup = setup
    this.random = random

    this.windDirection = new OrnsteinUhlenbeck(random.derive('wind-direction'), {
      mean: 0,
      sigma: setup.wind.directionSigmaDegrees,
      timeConstantSeconds: setup.wind.directionTimeConstantSeconds,
      initial: 0,
    })
    this.windSpeed = new GustModel(random.derive('wind-speed'), {
      meanKnots: setup.wind.speedKnots,
      sigmaKnots: setup.wind.speedSigmaKnots,
      timeConstantSeconds: setup.wind.speedTimeConstantSeconds,
      gustKnots: setup.wind.gustKnots,
      gustIntervalSeconds: setup.wind.gustIntervalSeconds,
      gustDurationSeconds: setup.wind.gustDurationSeconds,
    })
    this.currentDrift = new OrnsteinUhlenbeck(random.derive('current-drift'), {
      mean: setup.current.driftKnots,
      sigma: setup.current.driftSigmaKnots,
      timeConstantSeconds: 900,
      min: 0,
      max: 8,
    })
    this.currentSet = new OrnsteinUhlenbeck(random.derive('current-set'), {
      mean: 0,
      sigma: 8,
      timeConstantSeconds: 1200,
    })
    this.waterTemperature = new OrnsteinUhlenbeck(random.derive('water-temperature'), {
      mean: setup.waterTemperatureC,
      sigma: setup.waterTemperatureSigmaC,
      // Water temperature moves very slowly indeed.
      timeConstantSeconds: 2400,
      min: -2,
      max: 40,
    })
    this.airTemperature = new OrnsteinUhlenbeck(random.derive('air-temperature'), {
      mean: setup.airTemperatureC,
      sigma: 0.8,
      timeConstantSeconds: 1800,
      min: -30,
      max: 55,
    })
    this.airPressure = new OrnsteinUhlenbeck(random.derive('air-pressure'), {
      mean: setup.airPressureHpa,
      sigma: setup.airPressureSigmaHpa,
      timeConstantSeconds: 3600,
      min: 900,
      max: 1080,
    })
    this.humidity = new OrnsteinUhlenbeck(random.derive('humidity'), {
      mean: setup.relativeHumidityPercent,
      sigma: 4,
      timeConstantSeconds: 1800,
      min: 5,
      max: 100,
    })
    this.seabedNoise = new ValueNoise(hashString(`${random.seed}:seabed`))
    this.depthNoise = new OrnsteinUhlenbeck(random.derive('depth-noise'), {
      mean: 0,
      sigma: 0.12,
      timeConstantSeconds: 6,
    })
  }

  /**
   * Replace the environment setup (used when switching scenarios at runtime).
   *
   * Every mean-reverting process is snapped to its new mean rather than being
   * left to drift there: switching to the storm scenario should produce a gale
   * immediately, not in ten minutes' time.
   */
  reconfigure(setup: EnvironmentSetup): void {
    this.setup = setup
    this.windDirection.configure({
      sigma: setup.wind.directionSigmaDegrees,
      timeConstantSeconds: setup.wind.directionTimeConstantSeconds,
    })
    this.windSpeed.configure({
      meanKnots: setup.wind.speedKnots,
      sigmaKnots: setup.wind.speedSigmaKnots,
      timeConstantSeconds: setup.wind.speedTimeConstantSeconds,
      gustKnots: setup.wind.gustKnots,
      gustIntervalSeconds: setup.wind.gustIntervalSeconds,
      gustDurationSeconds: setup.wind.gustDurationSeconds,
    })
    this.currentDrift.configure({ mean: setup.current.driftKnots, sigma: setup.current.driftSigmaKnots })
    this.waterTemperature.configure({ mean: setup.waterTemperatureC, sigma: setup.waterTemperatureSigmaC })
    this.airTemperature.configure({ mean: setup.airTemperatureC })
    this.airPressure.configure({ mean: setup.airPressureHpa, sigma: setup.airPressureSigmaHpa })
    this.humidity.configure({ mean: setup.relativeHumidityPercent })

    this.windSpeed.resetToMean()
    this.windDirection.value = 0
    this.currentSet.value = 0
    this.currentDrift.value = setup.current.driftKnots
    this.waterTemperature.value = setup.waterTemperatureC
    this.airTemperature.value = setup.airTemperatureC
    this.airPressure.value = setup.airPressureHpa
    this.humidity.value = setup.relativeHumidityPercent
    this.trueWindSpeedKnots = setup.wind.speedKnots
    this.depthNoise.value = 0
    // The sea has to build; it is the one thing that does not snap.
    this.wavePhase = 0
    this.pitchPhase = 0
  }

  get currentSetup(): EnvironmentSetup {
    return this.setup
  }

  /** True wind direction (blowing from), degrees true. */
  get trueWindDirectionDegrees(): number {
    return normalizeDegrees360(this.setup.wind.directionDegrees + this.windDirection.value)
  }

  /** True wind speed including any active gust, knots. */
  trueWindSpeedKnots = 0

  get gusting(): boolean {
    return this.windSpeed.gusting
  }

  get gustKnots(): number {
    return this.windSpeed.gustKnots
  }

  /** Direction the current flows towards, degrees true. */
  get currentSetDegrees(): number {
    return normalizeDegrees360(this.setup.current.setDegrees + this.currentSet.value)
  }

  get currentDriftKnots(): number {
    return Math.max(0, this.currentDrift.value)
  }

  get waterTemperatureC(): number {
    return this.waterTemperature.value
  }

  get airTemperatureC(): number {
    return this.airTemperature.value
  }

  get airPressureHpa(): number {
    return this.airPressure.value
  }

  get relativeHumidityPercent(): number {
    return clamp(this.humidity.value, 1, 100)
  }

  get waveState(): WaveState {
    return this.waves
  }

  /** Override the true wind directly (used by `PATCH /state`). */
  setTrueWind(options: { directionDegrees?: number | undefined; speedKnots?: number | undefined }): void {
    if (options.directionDegrees !== undefined) {
      this.setup = {
        ...this.setup,
        wind: { ...this.setup.wind, directionDegrees: normalizeDegrees360(options.directionDegrees) },
      }
      this.windDirection.value = 0
    }
    if (options.speedKnots !== undefined) {
      const speed = clamp(options.speedKnots, 0, 200)
      this.setup = { ...this.setup, wind: { ...this.setup.wind, speedKnots: speed } }
      this.windSpeed.configure({ meanKnots: speed })
      this.trueWindSpeedKnots = speed
    }
  }

  setWaterTemperature(celsius: number): void {
    const value = clamp(celsius, -2, 40)
    this.setup = { ...this.setup, waterTemperatureC: value }
    this.waterTemperature.configure({ mean: value })
    this.waterTemperature.value = value
  }

  setAirPressure(hectopascals: number): void {
    const value = clamp(hectopascals, 850, 1100)
    this.setup = { ...this.setup, airPressureHpa: value }
    this.airPressure.configure({ mean: value })
    this.airPressure.value = value
  }

  setCurrent(options: { setDegrees?: number | undefined; driftKnots?: number | undefined }): void {
    if (options.setDegrees !== undefined) {
      this.setup = {
        ...this.setup,
        current: { ...this.setup.current, setDegrees: normalizeDegrees360(options.setDegrees) },
      }
      this.currentSet.value = 0
    }
    if (options.driftKnots !== undefined) {
      const drift = clamp(options.driftKnots, 0, 12)
      this.setup = { ...this.setup, current: { ...this.setup.current, driftKnots: drift } }
      this.currentDrift.configure({ mean: drift })
      this.currentDrift.value = drift
    }
  }

  setDepth(meters: number): void {
    const value = clamp(meters, 0.2, 12000)
    this.setup = { ...this.setup, seabed: { ...this.setup.seabed, depthMeters: value } }
  }

  /** Advance every environmental process by `dtSeconds`. */
  step(dtSeconds: number): void {
    const dt = Math.max(0, dtSeconds)
    this.elapsedSeconds += dt

    this.windDirection.step(dt)
    this.trueWindSpeedKnots = Math.max(0, this.windSpeed.step(dt))
    this.currentDrift.step(dt)
    this.currentSet.step(dt)
    this.waterTemperature.step(dt)
    this.airTemperature.step(dt)
    this.airPressure.step(dt)
    this.humidity.step(dt)
    this.depthNoise.step(dt)

    this.stepWaves(dt)
  }

  private stepWaves(dtSeconds: number): void {
    const targetHeight = significantWaveHeight(this.trueWindSpeedKnots, this.setup.fetchFactor)
    // The sea takes time to build and time to lie down again.
    const alpha = smoothingAlpha(dtSeconds, targetHeight > this.waves.significantHeightMeters ? 240 : 600)
    const height = this.waves.significantHeightMeters + (targetHeight - this.waves.significantHeightMeters) * alpha
    const period = waveperiodSeconds(height)

    this.wavePhase = (this.wavePhase + (2 * Math.PI * dtSeconds) / period) % (2 * Math.PI)
    // A second, slower phase keeps pitch and roll from locking together.
    this.pitchPhase = (this.pitchPhase + (2 * Math.PI * dtSeconds) / (period * 1.37)) % (2 * Math.PI)

    const amplitude = height / 2
    this.waves = {
      significantHeightMeters: height,
      periodSeconds: period,
      heaveMeters: amplitude * Math.sin(this.wavePhase),
      rollDegrees: clamp(height * 1.6, 0, 18) * Math.sin(this.wavePhase + 0.7),
      pitchDegrees: clamp(height * 1.1, 0, 12) * Math.sin(this.pitchPhase),
    }
  }

  /**
   * Depth of water below the surface at a position.
   *
   * The seabed is a smooth, *position-indexed* function, so sailing back over
   * the same ground reproduces the same contour rather than a fresh random
   * number. Tide and a small sensor-scale noise term are added on top.
   */
  depthBelowSurfaceMeters(position: GeoPosition): number {
    const { seabed } = this.setup
    const scaleNm = Math.max(0.05, seabed.featureScaleNm)
    // 1 degree of latitude is 60 nm; longitude is scaled by the same amount so
    // features stay roughly isotropic at mid latitudes.
    const latIndex = (position.latitude * 60) / scaleNm
    const lonIndex = (position.longitude * 60 * Math.cos((position.latitude * Math.PI) / 180)) / scaleNm
    const contour =
      this.seabedNoise.fractal(latIndex, 3, 0.55) * 0.6 + this.seabedNoise.fractal(lonIndex + 500.5, 3, 0.55) * 0.4

    const tide =
      (seabed.tideRangeMeters / 2) *
      Math.sin((2 * Math.PI * this.elapsedSeconds) / Math.max(60, seabed.tidePeriodSeconds))

    const depth =
      seabed.depthMeters + contour * seabed.depthVariationMeters + tide + this.depthNoise.value + this.waves.heaveMeters * 0.5

    // A depth sounder never reads zero or negative; clamp to a plausible floor.
    return clamp(depth, 0.4, 12000)
  }

  /** Exposed so scenarios can add their own deterministic jitter. */
  get rng(): Random {
    return this.random
  }
}
