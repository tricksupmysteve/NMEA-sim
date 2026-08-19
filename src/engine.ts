/**
 * The simulator engine.
 *
 * Owns the clock, the scheduler, the world, the encoder and the transports, and
 * wires them together:
 *
 *   physics tick  →  world state
 *   sensor tick   →  instrument snapshot (one task per instrument, own rate)
 *   sentence tick →  encoder  →  every transport (one task per sentence, own rate)
 *
 * There is deliberately no single one-second timer: each instrument and each
 * sentence is an independent scheduled task, which is what lets a consumer see
 * genuinely different data ages per source.
 *
 * The engine is transport- and protocol-agnostic at its boundaries, so an
 * NMEA 2000 or Signal K transport can be added by registering another
 * `SentenceTransport`-shaped sink against the same `BoatState`.
 */

import { activeSentenceIds, type SimulatorConfig } from './config.js'
import { createLogger, silentLogger, type Logger } from './core/logger.js'
import { Random } from './core/random.js'
import {
  ManualClock,
  ManualDriver,
  RealTimeDriver,
  Scheduler,
  SimulationClock,
  type Clock,
  type Driver,
} from './simulator/clock.js'
import { applyChecksumCorruption, applyMalformation, NmeaEncoder } from './nmea0183/encoder.js'
import { PROFILES } from './nmea0183/profiles.js'
import { getSentenceDefinition } from './nmea0183/registry.js'
import type { EncoderSettings, SentenceId } from './nmea0183/types.js'
import { getScenario, listScenarios } from './scenarios/index.js'
import type { ScenarioInstance, ScenarioName } from './scenarios/types.js'
import type { FaultAction, FaultLogEntry } from './simulator/faults.js'
import type { ChannelFault, InstrumentStatus } from './simulator/instruments.js'
import { World } from './simulator/world.js'
import { NmeaTcpServer, type TcpClientInfo } from './transports/tcp.js'
import { NmeaUdpTransport } from './transports/udp.js'
import type { SentenceTransport, TransportStats } from './transports/transport.js'
import type { BoatState, BoatStatePatch, InstrumentId } from './types.js'

export interface EngineDependencies {
  logger?: Logger
  /** Inject a clock and driver to run the engine deterministically in tests. */
  clock?: Clock
  driver?: (scheduler: Scheduler, clock: Clock) => Driver
  /** Replace the transports entirely; defaults to TCP (plus UDP if enabled). */
  transports?: SentenceTransport[]
}

export interface SentenceEmission {
  id: SentenceId
  text: string
  faulted: boolean
  atMs: number
}

export interface EngineStats {
  startedAt: string
  uptimeSeconds: number
  simulatedSeconds: number
  scenario: ScenarioName
  profile: string
  seed: number
  sentencesEmitted: number
  sentencesByType: Record<string, number>
  faultedSentences: number
  rejectedSentences: number
  transports: TransportStats[]
}

const PHYSICS_TASK_ID = '@physics'
const SCENARIO_TASK_ID = '@scenario'

export class SimulatorEngine {
  readonly config: SimulatorConfig

  readonly logger: Logger

  private readonly clock: Clock

  private readonly scheduler: Scheduler

  private readonly driverFactory: (scheduler: Scheduler, clock: Clock) => Driver

  private driver: Driver | null = null

  private world: World

  private scenarioInstance: ScenarioInstance

  private scenarioName: ScenarioName

  private readonly encoder: NmeaEncoder

  private readonly transports: SentenceTransport[]

  private readonly tcpServer: NmeaTcpServer | null

  private readonly listeners = new Set<(emission: SentenceEmission) => void>()

  private readonly startedAtMs: number

  private readonly startEpochMs: number

  private sentencesEmitted = 0

  private faultedSentences = 0

  private readonly sentenceCounts = new Map<SentenceId, number>()

  private readonly lastEmitAtMs = new Map<SentenceId, number>()

  private running = false

  constructor(config: SimulatorConfig, dependencies: EngineDependencies = {}) {
    this.config = config
    this.logger = dependencies.logger ?? (config.quiet ? silentLogger : createLogger(config.logLevel))

    this.startEpochMs = config.startEpochMs ?? Date.now()
    this.clock = dependencies.clock ?? new SimulationClock(this.startEpochMs, config.timeScale)
    this.startedAtMs = this.clock.now()
    this.scheduler = new Scheduler(this.startedAtMs)
    this.driverFactory =
      dependencies.driver ??
      ((scheduler, clock) =>
        clock instanceof ManualClock
          ? new ManualDriver(scheduler, clock)
          : new RealTimeDriver(scheduler, clock, this.heartbeatMs(), (error) => this.logger.error('scheduler error', error)))

    this.scenarioName = config.scenario
    this.scenarioInstance = getScenario(config.scenario).create(new Random(config.seed, 'scenario'))

    this.world = new World(
      this.scenarioInstance.setup,
      {
        seed: config.seed,
        magneticVariationDegrees: config.magneticVariationDegrees,
        compassDeviationDegrees: config.compassDeviationDegrees,
        instrumentIntervals: config.instrumentIntervalsMs,
        instrumentEnabled: config.instrumentEnabled,
        ownShip: config.ownShip,
        gnssAccuracyMeters: config.gnssAccuracyMeters,
      },
      this.startedAtMs,
      (entry) => this.onFaultEvent(entry),
    )
    this.world.faults.setTimeline(this.scenarioInstance.faults)
    this.world.sampleAll(this.startedAtMs)

    this.encoder = new NmeaEncoder(this.encoderSettings())

    if (dependencies.transports) {
      this.transports = dependencies.transports
      this.tcpServer = (dependencies.transports.find((transport) => transport instanceof NmeaTcpServer) as NmeaTcpServer | undefined) ?? null
    } else {
      this.tcpServer = new NmeaTcpServer({
        host: config.nmea.host,
        port: config.nmea.port,
        maxClients: config.nmea.maxClients,
        highWaterMarkBytes: config.nmea.highWaterMarkBytes,
        hardLimitBytes: config.nmea.hardLimitBytes,
        onClientConnect: (client) => this.onClientConnect(client),
        onClientDisconnect: (client, reason) => this.onClientDisconnect(client, reason),
        onError: (error, client) =>
          this.logger.warn(`TCP error${client ? ` (client ${client.id})` : ''}: ${error.message}`),
      })
      this.transports = [this.tcpServer]
      if (config.udp.enabled) {
        this.transports.push(
          new NmeaUdpTransport({
            host: config.udp.host,
            port: config.udp.port,
            broadcast: config.udp.broadcast,
            onError: (error) => this.logger.warn(`UDP error: ${error.message}`),
          }),
        )
      }
    }

    this.registerTasks()
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.running) return
    for (const transport of this.transports) {
      await transport.start()
    }
    this.driver = this.driverFactory(this.scheduler, this.clock)
    this.driver.start()
    this.running = true
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.driver?.stop()
    this.driver = null
    for (const transport of this.transports) {
      await transport.stop()
    }
    this.listeners.clear()
  }

  get isRunning(): boolean {
    return this.running
  }

  /** The bound TCP address; meaningful only once started. */
  tcpAddress(): { host: string; port: number } | null {
    return this.tcpServer?.address() ?? null
  }

  /** Exposed so tests can drive the engine deterministically. */
  get simulationDriver(): Driver | null {
    return this.driver
  }

  get simulationClock(): Clock {
    return this.clock
  }

  get taskScheduler(): Scheduler {
    return this.scheduler
  }

  // ------------------------------------------------------------------- state

  get state(): BoatState {
    return this.world.boatState
  }

  get currentScenario(): ScenarioName {
    return this.scenarioName
  }

  get simulationWorld(): World {
    return this.world
  }

  instrumentStatus(): InstrumentStatus[] {
    return this.world.instrumentStatus(this.clock.now())
  }

  /** Age of the most recent transmission of each sentence, in milliseconds. */
  sentenceAges(): Array<{ id: SentenceId; hz: number; lastEmittedMs: number | null; ageMs: number | null; count: number }> {
    const now = this.clock.now()
    return activeSentenceIds(this.config).map((id) => {
      const last = this.lastEmitAtMs.get(id) ?? null
      return {
        id,
        hz: this.config.sentenceRatesHz[id] ?? 0,
        lastEmittedMs: last,
        ageMs: last === null ? null : Math.max(0, now - last),
        count: this.sentenceCounts.get(id) ?? 0,
      }
    })
  }

  clients(): TcpClientInfo[] {
    return this.tcpServer?.listClients() ?? []
  }

  stats(): EngineStats {
    const sentencesByType: Record<string, number> = {}
    for (const [id, count] of this.sentenceCounts) sentencesByType[id] = count
    let rejected = 0
    for (const count of this.encoder.rejected.values()) rejected += count

    return {
      startedAt: new Date(this.startEpochMs).toISOString(),
      uptimeSeconds: Math.max(0, (this.clock.now() - this.startedAtMs) / 1000),
      simulatedSeconds: this.world.elapsed,
      scenario: this.scenarioName,
      profile: this.config.profile,
      seed: this.config.seed,
      sentencesEmitted: this.sentencesEmitted,
      sentencesByType,
      faultedSentences: this.faultedSentences,
      rejectedSentences: rejected,
      transports: this.transports.map((transport) => transport.stats()),
    }
  }

  // ------------------------------------------------------------------ control

  /** Switch scenario in place, keeping every connection open. */
  setScenario(name: ScenarioName): void {
    const definition = getScenario(name)
    this.scenarioName = name
    this.scenarioInstance = definition.create(new Random(this.config.seed, 'scenario'))
    this.world.reconfigure(this.scenarioInstance.setup, this.scenarioInstance.faults, this.clock.now())
    this.logger.info(`Scenario changed to "${name}"`)
  }

  static availableScenarios(): ReturnType<typeof listScenarios> {
    return listScenarios()
  }

  setInstrumentEnabled(instrument: InstrumentId, enabled: boolean): void {
    const channel = this.world.channels[instrument]
    channel.enabled = enabled
    if (enabled) {
      this.world.sample(instrument, this.clock.now())
    }
    this.logger.info(`Instrument ${instrument} ${enabled ? 'enabled' : 'disabled'}`)
  }

  setInstrumentFault(instrument: InstrumentId, fault: ChannelFault): void {
    this.world.channels[instrument].fault = fault
    this.logger.info(`Instrument ${instrument} fault set to "${fault}"`)
  }

  applyFault(action: FaultAction): void {
    this.world.faults.apply(action)
  }

  patchState(patch: BoatStatePatch): void {
    this.world.applyPatch(patch, this.clock.now())
  }

  /** Change a sentence's transmission rate at runtime. 0 stops it. */
  setSentenceRate(id: SentenceId, hz: number): void {
    if (hz <= 0) {
      delete this.config.sentenceRatesHz[id]
      this.scheduler.remove(sentenceTaskId(id))
      return
    }
    this.config.sentenceRatesHz[id] = hz
    const taskId = sentenceTaskId(id)
    if (this.scheduler.has(taskId)) {
      this.scheduler.setInterval(taskId, 1000 / hz)
    } else {
      this.addSentenceTask(id, hz)
    }
    this.restartDriver()
  }

  onSentence(listener: (emission: SentenceEmission) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ------------------------------------------------------------------ private

  private heartbeatMs(): number {
    // Fast enough that the highest-rate sentence is never late, but not so fast
    // that the process spins: a quarter of the shortest interval, capped.
    const shortest = this.scheduler.minimumIntervalMs(1000 / Math.max(1, this.config.physicsHz))
    return Math.max(2, Math.min(100, Math.floor(shortest / 4) || 5))
  }

  private restartDriver(): void {
    if (!this.running) return
    this.driver?.stop()
    this.driver = this.driverFactory(this.scheduler, this.clock)
    this.driver.start()
  }

  private encoderSettings(): EncoderSettings {
    const talkers: Partial<Record<SentenceId, string>> = {}
    for (const entry of PROFILES[this.config.profile].sentences) {
      if (entry.talker) talkers[entry.id] = entry.talker
    }
    return {
      talkers,
      magneticVariationDegrees: this.config.magneticVariationDegrees,
      ownShip: this.config.ownShip,
      coordinateDecimals: this.config.coordinateDecimals,
      timeDecimals: this.config.timeDecimals,
    }
  }

  private registerTasks(): void {
    // Physics first within any tick, then sensors, then sentence emission.
    this.scheduler.add({
      id: PHYSICS_TASK_ID,
      intervalMs: 1000 / this.config.physicsHz,
      order: 0,
      run: (atMs) => {
        this.world.stepPhysics(atMs)
      },
    })

    this.scheduler.add({
      id: SCENARIO_TASK_ID,
      intervalMs: 1000 / this.config.physicsHz,
      order: 1,
      run: () => {
        this.scenarioInstance.update?.(this.world, 1 / this.config.physicsHz, this.world.elapsed)
      },
    })

    for (const [instrument, intervalMs] of Object.entries(this.config.instrumentIntervalsMs) as Array<[InstrumentId, number]>) {
      this.scheduler.add({
        id: `sensor:${instrument}`,
        intervalMs,
        order: 2,
        run: (atMs) => this.world.sample(instrument, atMs),
      })
    }

    for (const id of activeSentenceIds(this.config)) {
      this.addSentenceTask(id, this.config.sentenceRatesHz[id] ?? getSentenceDefinition(id).defaultHz)
    }
  }

  private addSentenceTask(id: SentenceId, hz: number): void {
    this.scheduler.add({
      id: sentenceTaskId(id),
      intervalMs: 1000 / hz,
      order: 3,
      run: (atMs) => this.emit(id, atMs),
    })
  }

  private emit(id: SentenceId, atMs: number): void {
    const encoded = this.encoder.encode(id, {
      now: new Date(atMs),
      state: this.world.boatState,
      channels: this.world.channels,
    })
    if (encoded.length === 0) return

    for (const sentence of encoded) {
      // Wire faults are decided per transmitted sentence, so "inject five bad
      // checksums" damages exactly five sentences.
      const fault = this.world.faults.nextWireFault()
      let text = sentence.text
      let faulted = false
      if (fault.malform) {
        text = applyMalformation(text)
        faulted = true
      } else if (fault.corruptChecksum) {
        text = applyChecksumCorruption(text)
        faulted = true
      }

      for (const transport of this.transports) {
        transport.broadcast(text)
      }

      this.sentencesEmitted += 1
      if (faulted) this.faultedSentences += 1
      this.sentenceCounts.set(id, (this.sentenceCounts.get(id) ?? 0) + 1)
      this.lastEmitAtMs.set(id, atMs)

      if (this.listeners.size > 0) {
        const emission: SentenceEmission = { id, text, faulted, atMs }
        for (const listener of this.listeners) listener(emission)
      }
      if (this.config.logNmea) {
        this.logger.write(text.replace(/\r\n$/, ''))
      }
    }
  }

  private onFaultEvent(entry: FaultLogEntry): void {
    this.logger.info(`Fault at t+${entry.atSeconds.toFixed(0)}s: ${entry.note}`)
  }

  private onClientConnect(client: TcpClientInfo): void {
    this.logger.write(`Client connected: ${client.remoteAddress}:${client.remotePort} (id ${client.id})`)
  }

  private onClientDisconnect(client: TcpClientInfo, reason: string): void {
    const seconds = Math.max(0, (Date.now() - client.connectedAt.getTime()) / 1000)
    this.logger.write(
      `Client disconnected: ${client.remoteAddress}:${client.remotePort} (id ${client.id}, ${reason}, ` +
        `${client.sentencesSent} sentences in ${seconds.toFixed(0)}s${client.dropped > 0 ? `, ${client.dropped} dropped` : ''})`,
    )
  }
}

function sentenceTaskId(id: SentenceId): string {
  return `sentence:${id}`
}
