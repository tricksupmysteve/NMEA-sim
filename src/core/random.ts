/**
 * Seeded pseudo-randomness.
 *
 * Every stochastic process in the simulator draws from a *named substream*
 * derived from the master seed. Naming the substreams means that adding a new
 * noise source later does not shift the numbers consumed by existing ones, so
 * `SIM_SEED=12345` keeps reproducing substantially the same run across
 * versions.
 */

/** 32-bit string hash (FNV-1a) used to derive substream seeds from labels. */
export function hashString(input: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG. Deterministic and
 * portable across Node versions and architectures (all operations are 32-bit
 * integer ops plus one float division).
 */
export class Random {
  private state: number

  readonly seed: number

  readonly label: string

  private spareGaussian: number | null = null

  constructor(seed: number, label = 'root') {
    this.seed = seed >>> 0
    this.label = label
    this.state = this.seed
  }

  /** Derive an independent, reproducible substream. */
  derive(label: string): Random {
    return new Random((this.seed ^ hashString(label)) >>> 0, `${this.label}/${label}`)
  }

  /** Restart this stream from its seed. */
  reset(): void {
    this.state = this.seed
    this.spareGaussian = null
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** Uniform integer in [min, max] inclusive. */
  integer(min: number, max: number): number {
    const low = Math.ceil(min)
    const high = Math.floor(max)
    if (high <= low) return low
    return low + Math.floor(this.next() * (high - low + 1))
  }

  /** `true` with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability
  }

  /** Standard normal sample (Box–Muller with a cached spare). */
  gaussian(mean = 0, standardDeviation = 1): number {
    if (this.spareGaussian !== null) {
      const spare = this.spareGaussian
      this.spareGaussian = null
      return mean + spare * standardDeviation
    }
    let u = 0
    let v = 0
    let s = 0
    do {
      u = this.next() * 2 - 1
      v = this.next() * 2 - 1
      s = u * u + v * v
    } while (s >= 1 || s === 0)
    const factor = Math.sqrt((-2 * Math.log(s)) / s)
    this.spareGaussian = v * factor
    return mean + u * factor * standardDeviation
  }

  /** Pick one element of a non-empty array. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Random.pick requires a non-empty array')
    const item = items[this.integer(0, items.length - 1)]
    // `noUncheckedIndexedAccess` — the bounds above guarantee this is defined.
    return item as T
  }
}

/**
 * Ornstein–Uhlenbeck process: a mean-reverting random walk.
 *
 * This is the workhorse for "vary smoothly and plausibly" quantities such as
 * heading wander, boat speed, depth and temperature. Unlike white noise it has
 * memory, so successive samples are correlated and the output never jumps.
 */
export class OrnsteinUhlenbeck {
  private currentValue: number

  constructor(
    private readonly random: Random,
    private options: {
      /** Long-run mean the process reverts to. */
      mean: number
      /** Typical deviation from the mean once settled. */
      sigma: number
      /** Seconds for a displacement to decay by ~63%. Larger = slower. */
      timeConstantSeconds: number
      /** Optional hard bounds applied after each step. */
      min?: number | undefined
      max?: number | undefined
      initial?: number | undefined
    },
  ) {
    this.currentValue = options.initial ?? options.mean
  }

  get value(): number {
    return this.currentValue
  }

  set value(next: number) {
    this.currentValue = next
  }

  get mean(): number {
    return this.options.mean
  }

  /** Retune the process without losing its current value (used on scenario changes). */
  configure(changes: Partial<{ mean: number; sigma: number; timeConstantSeconds: number; min: number; max: number }>): void {
    this.options = { ...this.options, ...changes }
  }

  step(dtSeconds: number): number {
    const { mean, sigma, timeConstantSeconds, min, max } = this.options
    const theta = 1 / Math.max(1e-3, timeConstantSeconds)
    const dt = Math.max(0, dtSeconds)
    // Exact discretisation of the OU process keeps the stationary variance
    // correct regardless of step size.
    const decay = Math.exp(-theta * dt)
    const diffusion = sigma * Math.sqrt(Math.max(0, 1 - decay * decay))
    let next = mean + (this.currentValue - mean) * decay + diffusion * this.random.gaussian()
    if (min !== undefined && next < min) next = min
    if (max !== undefined && next > max) next = max
    this.currentValue = next
    return next
  }
}

/**
 * Gust model for wind speed.
 *
 * Produces a base wind that drifts slowly, plus discrete gust envelopes that
 * ramp up and decay. Wind never simply jumps between random values.
 */
export class GustModel {
  private readonly base: OrnsteinUhlenbeck

  private gustStrength = 0

  private gustRemainingSeconds = 0

  private gustPeakKnots = 0

  private gustDurationSeconds = 1

  private secondsUntilNextGust: number

  constructor(
    private readonly random: Random,
    private options: {
      /** Mean base wind speed in knots. */
      meanKnots: number
      /** Drift of the base wind, in knots. */
      sigmaKnots: number
      /** Seconds of memory for the base wind. */
      timeConstantSeconds: number
      /** Mean gust overshoot above the base wind, in knots. */
      gustKnots: number
      /** Mean seconds between gusts. */
      gustIntervalSeconds: number
      /** Mean gust duration in seconds. */
      gustDurationSeconds: number
    },
  ) {
    this.base = new OrnsteinUhlenbeck(random.derive('base'), {
      mean: options.meanKnots,
      sigma: options.sigmaKnots,
      timeConstantSeconds: options.timeConstantSeconds,
      min: 0,
    })
    this.secondsUntilNextGust = random.range(0.2, 1) * options.gustIntervalSeconds
  }

  configure(changes: Partial<GustModel['options']>): void {
    this.options = { ...this.options, ...changes }
    this.base.configure({
      mean: this.options.meanKnots,
      sigma: this.options.sigmaKnots,
      timeConstantSeconds: this.options.timeConstantSeconds,
    })
  }

  get baseKnots(): number {
    return this.base.value
  }

  /**
   * Snap the base wind to its configured mean and cancel any gust in progress.
   * Used when a scenario is switched at runtime: the new conditions should
   * arrive at once rather than drifting in over the time constant.
   */
  resetToMean(): void {
    this.base.value = this.options.meanKnots
    this.gustStrength = 0
    this.gustRemainingSeconds = 0
    this.secondsUntilNextGust = this.random.range(0.2, 1) * this.options.gustIntervalSeconds
  }

  /** `true` while a gust envelope is active. */
  get gusting(): boolean {
    return this.gustRemainingSeconds > 0
  }

  /** Current gust contribution above the base wind, in knots. */
  get gustKnots(): number {
    return this.gustStrength
  }

  step(dtSeconds: number): number {
    const dt = Math.max(0, dtSeconds)
    const base = this.base.step(dt)

    this.secondsUntilNextGust -= dt
    if (this.gustRemainingSeconds <= 0 && this.secondsUntilNextGust <= 0) {
      this.gustDurationSeconds = Math.max(
        1,
        this.options.gustDurationSeconds * this.random.range(0.6, 1.8),
      )
      this.gustRemainingSeconds = this.gustDurationSeconds
      this.gustPeakKnots = Math.max(0, this.options.gustKnots * this.random.range(0.4, 1.6))
      this.secondsUntilNextGust =
        this.options.gustIntervalSeconds * this.random.range(0.5, 1.7) + this.gustDurationSeconds
    }

    if (this.gustRemainingSeconds > 0) {
      this.gustRemainingSeconds -= dt
      const elapsed = this.gustDurationSeconds - Math.max(0, this.gustRemainingSeconds)
      const phase = Math.min(1, Math.max(0, elapsed / this.gustDurationSeconds))
      // Asymmetric envelope: gusts build quickly and fade more slowly.
      const envelope = phase < 0.3 ? phase / 0.3 : Math.max(0, 1 - (phase - 0.3) / 0.7) ** 1.5
      this.gustStrength = this.gustPeakKnots * envelope
      if (this.gustRemainingSeconds <= 0) this.gustStrength = 0
    } else {
      this.gustStrength = 0
    }

    return Math.max(0, base + this.gustStrength)
  }
}

/**
 * Deterministic smooth 1-D value noise. Used where a *repeatable function of a
 * coordinate* is needed (for example seabed depth as a function of position)
 * rather than a time-evolving random walk.
 */
export class ValueNoise {
  private readonly seed: number

  constructor(seed: number) {
    this.seed = seed >>> 0
  }

  private hash(index: number): number {
    let h = (index ^ this.seed) >>> 0
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
    h = (h ^ (h >>> 16)) >>> 0
    return h / 4294967296
  }

  /** Smooth noise in [-1, 1] for any real coordinate. */
  sample(x: number): number {
    const safeX = Number.isFinite(x) ? x : 0
    const index = Math.floor(safeX)
    const fraction = safeX - index
    const a = this.hash(index)
    const b = this.hash(index + 1)
    // Smoothstep interpolation keeps the first derivative continuous.
    const t = fraction * fraction * (3 - 2 * fraction)
    return (a + (b - a) * t) * 2 - 1
  }

  /** Fractal sum of several octaves, still in roughly [-1, 1]. */
  fractal(x: number, octaves = 3, persistence = 0.5): number {
    let total = 0
    let amplitude = 1
    let frequency = 1
    let normalisation = 0
    for (let octave = 0; octave < octaves; octave += 1) {
      total += this.sample(x * frequency + octave * 137.17) * amplitude
      normalisation += amplitude
      amplitude *= persistence
      frequency *= 2
    }
    return normalisation === 0 ? 0 : total / normalisation
  }
}
