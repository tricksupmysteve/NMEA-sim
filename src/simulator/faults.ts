/**
 * Deterministic fault injection.
 *
 * Faults come in two families:
 *
 *  - *instrument* faults, which change what a sensor channel does (freeze,
 *    go offline, report invalid);
 *  - *wire* faults, which damage sentences on their way out (bad checksum,
 *    malformed sentence).
 *
 * A scenario supplies a timeline of fault events keyed on elapsed simulated
 * seconds, so the same seed and the same scenario always break in the same
 * order at the same moments. That is what makes the sensor-failure scenario
 * usable as a regression test for a consumer such as Matey.
 */

import type { InstrumentId } from '../types.js'
import type { ChannelFault, InstrumentChannels } from './instruments.js'

export type FaultAction =
  | { type: 'instrument'; instrument: InstrumentId; fault: ChannelFault }
  | { type: 'badChecksum'; count?: number | undefined; probability?: number | undefined; durationSeconds?: number | undefined }
  | { type: 'malformed'; count?: number | undefined; probability?: number | undefined; durationSeconds?: number | undefined }
  | { type: 'clearWireFaults' }
  | { type: 'clearAll' }

export interface FaultEvent {
  /** Elapsed simulated seconds at which the action fires. */
  atSeconds: number
  action: FaultAction
  /** Human-readable note surfaced in logs and on `GET /state`. */
  note?: string
}

export interface FaultTimeline {
  events: FaultEvent[]
  /** When set, the timeline repeats every `loopSeconds`. */
  loopSeconds?: number | undefined
}

export interface FaultLogEntry {
  atSeconds: number
  note: string
  action: FaultAction
}

/** What the encoder needs to know when it is about to write a sentence. */
export interface WireFaultDecision {
  corruptChecksum: boolean
  malform: boolean
}

export class FaultController {
  private timeline: FaultTimeline = { events: [] }

  private nextEventIndex = 0

  private loopOffsetSeconds = 0

  private badChecksumRemaining = 0

  private badChecksumProbability = 0

  private badChecksumUntilSeconds = Number.POSITIVE_INFINITY

  private malformedRemaining = 0

  private malformedProbability = 0

  private malformedUntilSeconds = Number.POSITIVE_INFINITY

  private elapsedSeconds = 0

  private readonly log: FaultLogEntry[] = []

  constructor(
    private readonly channels: InstrumentChannels,
    private readonly random: { next(): number },
    private readonly onEvent: (entry: FaultLogEntry) => void = () => {},
  ) {}

  /** Install a timeline and rewind it. Clears any faults already in effect. */
  setTimeline(timeline: FaultTimeline | undefined): void {
    this.clearAll()
    this.timeline = timeline ?? { events: [] }
    this.timeline.events.sort((a, b) => a.atSeconds - b.atSeconds)
    this.nextEventIndex = 0
    this.loopOffsetSeconds = this.elapsedSeconds
    this.log.length = 0
  }

  get history(): readonly FaultLogEntry[] {
    return this.log
  }

  get activeWireFaults(): { badChecksum: boolean; malformed: boolean } {
    return {
      badChecksum: this.badChecksumRemaining > 0 || (this.badChecksumProbability > 0 && this.elapsedSeconds < this.badChecksumUntilSeconds),
      malformed: this.malformedRemaining > 0 || (this.malformedProbability > 0 && this.elapsedSeconds < this.malformedUntilSeconds),
    }
  }

  /** Advance the timeline to `elapsedSeconds` of simulated time. */
  update(elapsedSeconds: number): void {
    this.elapsedSeconds = elapsedSeconds

    if (this.badChecksumProbability > 0 && elapsedSeconds >= this.badChecksumUntilSeconds) {
      this.badChecksumProbability = 0
      this.badChecksumUntilSeconds = Number.POSITIVE_INFINITY
    }
    if (this.malformedProbability > 0 && elapsedSeconds >= this.malformedUntilSeconds) {
      this.malformedProbability = 0
      this.malformedUntilSeconds = Number.POSITIVE_INFINITY
    }

    const { events, loopSeconds } = this.timeline
    if (events.length === 0) return

    let relative = elapsedSeconds - this.loopOffsetSeconds
    if (loopSeconds !== undefined && loopSeconds > 0 && relative >= loopSeconds) {
      // Start the timeline over: reset faults so each loop is identical.
      this.clearAll()
      this.loopOffsetSeconds += Math.floor(relative / loopSeconds) * loopSeconds
      this.nextEventIndex = 0
      relative = elapsedSeconds - this.loopOffsetSeconds
    }

    while (this.nextEventIndex < events.length) {
      const event = events[this.nextEventIndex]
      if (!event || event.atSeconds > relative) break
      this.nextEventIndex += 1
      this.apply(event.action)
      const entry: FaultLogEntry = {
        atSeconds: Number(relative.toFixed(2)),
        note: event.note ?? describe(event.action),
        action: event.action,
      }
      this.log.push(entry)
      if (this.log.length > 100) this.log.shift()
      this.onEvent(entry)
    }
  }

  /** Apply a fault action immediately (also used by the control API). */
  apply(action: FaultAction): void {
    switch (action.type) {
      case 'instrument': {
        const channel = this.channels[action.instrument]
        if (channel) channel.fault = action.fault
        break
      }
      case 'badChecksum': {
        if (action.count !== undefined) this.badChecksumRemaining += Math.max(0, Math.floor(action.count))
        if (action.probability !== undefined) {
          this.badChecksumProbability = Math.min(1, Math.max(0, action.probability))
          this.badChecksumUntilSeconds =
            action.durationSeconds === undefined
              ? Number.POSITIVE_INFINITY
              : this.elapsedSeconds + Math.max(0, action.durationSeconds)
        }
        break
      }
      case 'malformed': {
        if (action.count !== undefined) this.malformedRemaining += Math.max(0, Math.floor(action.count))
        if (action.probability !== undefined) {
          this.malformedProbability = Math.min(1, Math.max(0, action.probability))
          this.malformedUntilSeconds =
            action.durationSeconds === undefined
              ? Number.POSITIVE_INFINITY
              : this.elapsedSeconds + Math.max(0, action.durationSeconds)
        }
        break
      }
      case 'clearWireFaults':
        this.clearWireFaults()
        break
      case 'clearAll':
        this.clearAll()
        break
    }
  }

  clearWireFaults(): void {
    this.badChecksumRemaining = 0
    this.badChecksumProbability = 0
    this.badChecksumUntilSeconds = Number.POSITIVE_INFINITY
    this.malformedRemaining = 0
    this.malformedProbability = 0
    this.malformedUntilSeconds = Number.POSITIVE_INFINITY
  }

  clearAll(): void {
    this.clearWireFaults()
    for (const channel of Object.values(this.channels)) {
      channel.fault = 'none'
    }
  }

  /**
   * Decide whether the sentence about to be written should be damaged.
   *
   * Called once per emitted sentence; counted faults are consumed here so that
   * "inject three bad checksums" means exactly three sentences.
   */
  nextWireFault(): WireFaultDecision {
    let corruptChecksum = false
    let malform = false

    if (this.badChecksumRemaining > 0) {
      this.badChecksumRemaining -= 1
      corruptChecksum = true
    } else if (this.badChecksumProbability > 0 && this.elapsedSeconds < this.badChecksumUntilSeconds) {
      corruptChecksum = this.random.next() < this.badChecksumProbability
    }

    if (this.malformedRemaining > 0) {
      this.malformedRemaining -= 1
      malform = true
    } else if (this.malformedProbability > 0 && this.elapsedSeconds < this.malformedUntilSeconds) {
      malform = this.random.next() < this.malformedProbability
    }

    // A sentence is either mangled or mis-checksummed, not both — that keeps
    // each failure mode independently observable by the consumer.
    if (malform) corruptChecksum = false
    return { corruptChecksum, malform }
  }

  snapshot(): {
    pendingEvents: number
    badChecksumRemaining: number
    malformedRemaining: number
    badChecksumProbability: number
    malformedProbability: number
    history: FaultLogEntry[]
  } {
    return {
      pendingEvents: Math.max(0, this.timeline.events.length - this.nextEventIndex),
      badChecksumRemaining: this.badChecksumRemaining,
      malformedRemaining: this.malformedRemaining,
      badChecksumProbability: this.badChecksumProbability,
      malformedProbability: this.malformedProbability,
      history: [...this.log],
    }
  }
}

function describe(action: FaultAction): string {
  switch (action.type) {
    case 'instrument':
      return `${action.instrument} -> ${action.fault}`
    case 'badChecksum':
      return action.count !== undefined ? `inject ${action.count} bad checksum(s)` : `bad checksum p=${action.probability ?? 0}`
    case 'malformed':
      return action.count !== undefined ? `inject ${action.count} malformed sentence(s)` : `malformed p=${action.probability ?? 0}`
    case 'clearWireFaults':
      return 'clear wire faults'
    case 'clearAll':
      return 'all sensors restored'
  }
}
