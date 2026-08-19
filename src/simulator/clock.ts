/**
 * Simulation time and scheduling.
 *
 * The simulator deliberately does *not* hang everything off a single one-second
 * timer. Instead a `Scheduler` owns a set of independent tasks, each with its
 * own interval, and a `Driver` advances the scheduler. Two drivers exist:
 *
 *  - `RealTimeDriver` — a fast heartbeat used at runtime.
 *  - `ManualDriver`   — advanced explicitly by tests, so a seeded scenario
 *                       replays identically with no wall-clock involvement.
 */

export interface Clock {
  /** Milliseconds since the Unix epoch, as seen by the simulation. */
  now(): number
}

/** Wall-clock time, optionally scaled and offset from a fixed start instant. */
export class SimulationClock implements Clock {
  private readonly startWallMs: number

  constructor(
    private readonly startEpochMs: number,
    private readonly timeScale = 1,
    private readonly wallClock: () => number = Date.now,
  ) {
    this.startWallMs = wallClock()
  }

  now(): number {
    return this.startEpochMs + (this.wallClock() - this.startWallMs) * this.timeScale
  }

  /** Seconds of simulated time since start. */
  elapsedSeconds(): number {
    return (this.now() - this.startEpochMs) / 1000
  }
}

/** A clock that only moves when a test tells it to. */
export class ManualClock implements Clock {
  private current: number

  constructor(startEpochMs: number) {
    this.current = startEpochMs
  }

  now(): number {
    return this.current
  }

  set(epochMs: number): void {
    this.current = epochMs
  }

  advance(milliseconds: number): void {
    this.current += milliseconds
  }
}

export interface ScheduledTask {
  /** Stable identifier, used for logging, metrics and rate changes. */
  id: string
  /** Interval in milliseconds; must be > 0. */
  intervalMs: number
  /** Invoked with the scheduled time (not the actual time) for stability. */
  run: (scheduledAtMs: number) => void
  /** Tasks with a lower order run first within the same tick. */
  order?: number
  enabled?: boolean
}

interface TaskEntry {
  task: ScheduledTask
  nextDueMs: number
  runs: number
  lastRunMs: number | null
}

/**
 * Fixed-interval task scheduler with catch-up protection.
 *
 * `advanceTo` runs every task whose due time has passed, in due-time then
 * `order` sequence. If the process stalls (GC pause, a debugger, a laptop
 * sleeping), tasks are not replayed hundreds of times: the scheduler skips
 * ahead, bounded by `maxCatchUpRuns`.
 */
export class Scheduler {
  private readonly entries = new Map<string, TaskEntry>()

  private currentTimeMs: number

  private readonly maxCatchUpRuns: number

  constructor(startTimeMs: number, maxCatchUpRuns = 3) {
    this.currentTimeMs = startTimeMs
    this.maxCatchUpRuns = Math.max(1, maxCatchUpRuns)
  }

  get timeMs(): number {
    return this.currentTimeMs
  }

  add(task: ScheduledTask): void {
    if (!(task.intervalMs > 0) || !Number.isFinite(task.intervalMs)) {
      throw new Error(`Scheduler task "${task.id}" needs a positive finite intervalMs`)
    }
    this.entries.set(task.id, {
      task: { order: 0, enabled: true, ...task },
      nextDueMs: this.currentTimeMs + task.intervalMs,
      runs: 0,
      lastRunMs: null,
    })
  }

  remove(id: string): void {
    this.entries.delete(id)
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  setEnabled(id: string, enabled: boolean): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.task.enabled = enabled
    if (enabled) entry.nextDueMs = this.currentTimeMs + entry.task.intervalMs
  }

  /** Change a task's rate. The next due time is rebased from *now*. */
  setInterval(id: string, intervalMs: number): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) {
      throw new Error(`Scheduler task "${id}" needs a positive finite intervalMs`)
    }
    entry.task.intervalMs = intervalMs
    entry.nextDueMs = this.currentTimeMs + intervalMs
  }

  /** Shortest configured interval, used to size the real-time heartbeat. */
  minimumIntervalMs(fallback: number): number {
    let minimum = Number.POSITIVE_INFINITY
    for (const entry of this.entries.values()) {
      if (entry.task.enabled !== false) minimum = Math.min(minimum, entry.task.intervalMs)
    }
    return Number.isFinite(minimum) ? minimum : fallback
  }

  stats(): Array<{ id: string; intervalMs: number; runs: number; lastRunMs: number | null; enabled: boolean }> {
    return [...this.entries.values()].map((entry) => ({
      id: entry.task.id,
      intervalMs: entry.task.intervalMs,
      runs: entry.runs,
      lastRunMs: entry.lastRunMs,
      enabled: entry.task.enabled !== false,
    }))
  }

  /** Advance simulated time, running everything that fell due. */
  advanceTo(timeMs: number): void {
    if (timeMs < this.currentTimeMs) {
      // Time went backwards (clock adjustment). Rebase rather than replay.
      this.currentTimeMs = timeMs
      for (const entry of this.entries.values()) {
        entry.nextDueMs = timeMs + entry.task.intervalMs
      }
      return
    }

    // Collect the due runs first so ordering is deterministic across tasks.
    const due: Array<{ entry: TaskEntry; scheduledAtMs: number }> = []
    for (const entry of this.entries.values()) {
      if (entry.task.enabled === false) {
        entry.nextDueMs = Math.max(entry.nextDueMs, timeMs + entry.task.intervalMs)
        continue
      }
      let runs = 0
      while (entry.nextDueMs <= timeMs && runs < this.maxCatchUpRuns) {
        due.push({ entry, scheduledAtMs: entry.nextDueMs })
        entry.nextDueMs += entry.task.intervalMs
        runs += 1
      }
      if (entry.nextDueMs <= timeMs) {
        // Still behind after the catch-up budget: skip forward to the next slot
        // on the original phase so rates stay honest.
        const missed = Math.ceil((timeMs - entry.nextDueMs) / entry.task.intervalMs)
        entry.nextDueMs += missed * entry.task.intervalMs
      }
    }

    due.sort((a, b) => {
      if (a.scheduledAtMs !== b.scheduledAtMs) return a.scheduledAtMs - b.scheduledAtMs
      return (a.entry.task.order ?? 0) - (b.entry.task.order ?? 0)
    })

    for (const { entry, scheduledAtMs } of due) {
      this.currentTimeMs = scheduledAtMs
      entry.runs += 1
      entry.lastRunMs = scheduledAtMs
      entry.task.run(scheduledAtMs)
    }

    this.currentTimeMs = timeMs
  }
}

export interface Driver {
  start(): void
  stop(): void
}

/** Drives a scheduler from real time using a single Node timer. */
export class RealTimeDriver implements Driver {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly scheduler: Scheduler,
    private readonly clock: Clock,
    private readonly heartbeatMs: number,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  start(): void {
    if (this.timer) return
    const interval = Math.max(1, Math.min(this.heartbeatMs, 1000))
    this.timer = setInterval(() => {
      try {
        this.scheduler.advanceTo(this.clock.now())
      } catch (error) {
        this.onError(error)
      }
    }, interval)
    // Never hold the event loop open on our account during shutdown.
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}

/** Drives a scheduler from a `ManualClock`; used by deterministic tests. */
export class ManualDriver implements Driver {
  constructor(
    private readonly scheduler: Scheduler,
    private readonly clock: ManualClock,
  ) {}

  start(): void {
    /* nothing to do — the test advances time explicitly */
  }

  stop(): void {
    /* nothing to do */
  }

  /** Advance time in `stepMs` slices so per-tick physics stays accurate. */
  advance(milliseconds: number, stepMs = 20): void {
    const target = this.clock.now() + milliseconds
    const step = Math.max(1, stepMs)
    while (this.clock.now() + step < target) {
      this.clock.advance(step)
      this.scheduler.advanceTo(this.clock.now())
    }
    this.clock.set(target)
    this.scheduler.advanceTo(target)
  }
}
