/**
 * HTTP control API.
 *
 * Entirely separate from the NMEA TCP stream: this exists so a developer (or a
 * test) can inspect the simulated state and change scenarios, instruments and
 * faults while the stream keeps running. Nothing here is required for the NMEA
 * output to work — the simulator runs happily with `HTTP_ENABLED=false`.
 *
 * Built on the Node `http` module. A framework would add dependencies without
 * adding anything this handful of routes needs.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { activeSentenceIds } from '../config.js'
import type { Logger } from '../core/logger.js'
import { findLanAddresses } from '../core/net.js'
import { PROFILES } from '../nmea0183/profiles.js'
import { allSentenceDefinitions } from '../nmea0183/registry.js'
import { listScenarios } from '../scenarios/index.js'
import { isScenarioName } from '../scenarios/types.js'
import type { SimulatorEngine } from '../engine.js'
import {
  validateFaultAction,
  validateInstrumentUpdate,
  validateSentenceRate,
  validateStatePatch,
} from './validation.js'

/** Requests larger than this are rejected outright. */
const MAX_BODY_BYTES = 64 * 1024

export interface ControlApiOptions {
  host: string
  port: number
  token: string | null
  corsOrigin: string
  logger: Logger
}

interface RouteMatch {
  method: string
  pattern: RegExp
  handle: (context: RequestContext) => Promise<JsonResponse> | JsonResponse
}

interface RequestContext {
  params: string[]
  body: unknown
  url: URL
}

interface JsonResponse {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export class ControlApiServer {
  private readonly server: http.Server

  private readonly routes: RouteMatch[]

  private listening = false

  constructor(
    private readonly engine: SimulatorEngine,
    private readonly options: ControlApiOptions,
  ) {
    this.routes = this.buildRoutes()
    this.server = http.createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
  }

  address(): { host: string; port: number } | null {
    const address = this.server.address() as AddressInfo | string | null
    if (!address || typeof address === 'string') return null
    return { host: address.address, port: address.port }
  }

  start(): Promise<void> {
    if (this.listening) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      this.server.once('error', onError)
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off('error', onError)
        this.listening = true
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    if (!this.listening) return Promise.resolve()
    this.listening = false
    return new Promise((resolve) => {
      this.server.closeAllConnections?.()
      this.server.close(() => resolve())
    })
  }

  // ------------------------------------------------------------------ routing

  private buildRoutes(): RouteMatch[] {
    return [
      { method: 'GET', pattern: /^\/$/, handle: () => this.index() },
      { method: 'GET', pattern: /^\/health$/, handle: () => this.health() },
      { method: 'GET', pattern: /^\/state$/, handle: () => this.state() },
      { method: 'GET', pattern: /^\/config$/, handle: () => this.configuration() },
      { method: 'GET', pattern: /^\/scenarios$/, handle: () => this.scenarios() },
      { method: 'GET', pattern: /^\/instruments$/, handle: () => this.instruments() },
      { method: 'GET', pattern: /^\/sentences$/, handle: () => this.sentences() },
      { method: 'GET', pattern: /^\/clients$/, handle: () => this.clients() },
      { method: 'GET', pattern: /^\/metrics$/, handle: () => this.metrics() },
      { method: 'GET', pattern: /^\/faults$/, handle: () => this.faults() },

      { method: 'POST', pattern: /^\/scenario\/([A-Za-z0-9-]+)$/, handle: (context) => this.setScenario(context) },
      { method: 'PATCH', pattern: /^\/state$/, handle: (context) => this.patchState(context) },
      { method: 'POST', pattern: /^\/instruments\/([A-Za-z]+)$/, handle: (context) => this.updateInstrument(context) },
      { method: 'POST', pattern: /^\/faults$/, handle: (context) => this.applyFault(context) },
      { method: 'POST', pattern: /^\/sentences\/([A-Za-z0-9]+)\/rate$/, handle: (context) => this.setSentenceRate(context) },
    ]
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const origin = this.options.corsOrigin
    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
      'cache-control': 'no-store',
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers)
      response.end()
      return
    }

    let url: URL
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    } catch {
      this.send(response, headers, { status: 400, body: { error: 'Malformed request URL' } })
      return
    }

    // `/health` stays open so a platform health check works without a token.
    if (this.options.token !== null && url.pathname !== '/health') {
      const provided = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      if (provided !== this.options.token) {
        this.send(response, headers, { status: 401, body: { error: 'Unauthorized' } })
        return
      }
    }

    const path = url.pathname.replace(/\/+$/, '') || '/'
    const candidates = this.routes.filter((route) => route.pattern.test(path))
    if (candidates.length === 0) {
      this.send(response, headers, {
        status: 404,
        body: { error: 'Not found', path, routes: this.routes.map((route) => `${route.method} ${route.pattern.source}`) },
      })
      return
    }

    const route = candidates.find((candidate) => candidate.method === request.method)
    if (!route) {
      this.send(response, headers, {
        status: 405,
        body: { error: 'Method not allowed', allowed: candidates.map((candidate) => candidate.method) },
      })
      return
    }

    let body: unknown
    if (request.method === 'POST' || request.method === 'PATCH') {
      const parsed = await readJsonBody(request)
      if (!parsed.ok) {
        this.send(response, headers, { status: parsed.status, body: { error: parsed.error } })
        return
      }
      body = parsed.value
    }

    const match = route.pattern.exec(path)
    const params = match ? match.slice(1).map((value) => decodeURIComponent(value)) : []

    try {
      const result = await route.handle({ params, body, url })
      this.send(response, headers, result)
    } catch (error) {
      this.options.logger.error('Control API handler failed', error)
      this.send(response, headers, { status: 500, body: { error: 'Internal simulator error' } })
    }
  }

  private send(response: http.ServerResponse, baseHeaders: Record<string, string>, result: JsonResponse): void {
    const payload = JSON.stringify(result.body, null, 2)
    response.writeHead(result.status, { ...baseHeaders, ...result.headers })
    response.end(payload)
  }

  // ----------------------------------------------------------------- handlers

  private index(): JsonResponse {
    return {
      status: 200,
      body: {
        name: 'matey-nmea-simulator',
        description: 'NMEA 0183 marine instrument simulator with a raw TCP stream',
        nmeaTcp: this.engine.tcpAddress(),
        routes: {
          'GET /health': 'liveness and a one-line summary',
          'GET /state': 'canonical boat state, instrument freshness and sentence ages',
          'GET /config': 'effective configuration (secrets redacted)',
          'GET /scenarios': 'available scenarios',
          'GET /instruments': 'instrument enable/fault state and data age',
          'GET /sentences': 'sentence catalogue with configured rates',
          'GET /clients': 'connected TCP clients',
          'GET /metrics': 'counters',
          'GET /faults': 'active fault state and history',
          'POST /scenario/:name': 'switch scenario',
          'PATCH /state': 'override simulated values',
          'POST /instruments/:id': 'enable/disable or fault an instrument',
          'POST /faults': 'inject a fault',
          'POST /sentences/:id/rate': 'change a sentence transmission rate',
        },
      },
    }
  }

  private health(): JsonResponse {
    const stats = this.engine.stats()
    return {
      status: 200,
      body: {
        status: 'ok',
        scenario: stats.scenario,
        profile: stats.profile,
        seed: stats.seed,
        uptimeSeconds: Number(stats.uptimeSeconds.toFixed(1)),
        clients: stats.transports.reduce((total, transport) => total + transport.clients, 0),
        sentencesEmitted: stats.sentencesEmitted,
        nmeaTcp: this.engine.tcpAddress(),
      },
    }
  }

  private state(): JsonResponse {
    return {
      status: 200,
      body: {
        scenario: this.engine.currentScenario,
        state: this.engine.state,
        instruments: this.engine.instrumentStatus(),
        sentences: this.engine.sentenceAges(),
      },
    }
  }

  private configuration(): JsonResponse {
    const config = this.engine.config
    return {
      status: 200,
      body: {
        nodeEnv: config.nodeEnv,
        nmea: config.nmea,
        http: {
          enabled: config.http.enabled,
          host: config.http.host,
          port: config.http.port,
          // Never echo the token back.
          authRequired: config.http.token !== null,
          corsOrigin: config.http.corsOrigin,
        },
        udp: config.udp,
        scenario: config.scenario,
        profile: config.profile,
        profileDescription: PROFILES[config.profile].description,
        seed: config.seed,
        sentenceRatesHz: config.sentenceRatesHz,
        physicsHz: config.physicsHz,
        instrumentEnabled: config.instrumentEnabled,
        instrumentIntervalsMs: config.instrumentIntervalsMs,
        magneticVariationDegrees: config.magneticVariationDegrees,
        gnssAccuracyMeters: config.gnssAccuracyMeters,
        ownShip: config.ownShip,
        timeScale: config.timeScale,
        logNmea: config.logNmea,
        lanAddresses: findLanAddresses(),
      },
    }
  }

  private scenarios(): JsonResponse {
    return {
      status: 200,
      body: {
        active: this.engine.currentScenario,
        scenarios: listScenarios().map((scenario) => ({
          name: scenario.name,
          label: scenario.label,
          description: scenario.description,
          highlights: scenario.highlights,
        })),
      },
    }
  }

  private instruments(): JsonResponse {
    return { status: 200, body: { instruments: this.engine.instrumentStatus() } }
  }

  private sentences(): JsonResponse {
    const config = this.engine.config
    const active = new Set<string>(activeSentenceIds(config))
    const talkers = new Map(
      PROFILES[config.profile].sentences.map((entry) => [entry.id, entry.talker]),
    )
    return {
      status: 200,
      body: {
        profile: config.profile,
        sentences: allSentenceDefinitions().map((definition) => ({
          id: definition.id,
          active: active.has(definition.id),
          hz: config.sentenceRatesHz[definition.id] ?? 0,
          talker: talkers.get(definition.id) ?? definition.defaultTalker,
          requires: definition.requires,
          description: definition.description,
          nmea2000Pgns: definition.pgns ?? [],
        })),
      },
    }
  }

  private clients(): JsonResponse {
    return { status: 200, body: { clients: this.engine.clients() } }
  }

  private metrics(): JsonResponse {
    return { status: 200, body: this.engine.stats() }
  }

  private faults(): JsonResponse {
    return {
      status: 200,
      body: {
        ...this.engine.simulationWorld.faults.snapshot(),
        instruments: this.engine.instrumentStatus().map((status) => ({ id: status.id, fault: status.fault })),
      },
    }
  }

  private setScenario({ params }: RequestContext): JsonResponse {
    const name = (params[0] ?? '').toLowerCase()
    if (!isScenarioName(name)) {
      return {
        status: 404,
        body: { error: `Unknown scenario "${params[0] ?? ''}"`, available: listScenarios().map((s) => s.name) },
      }
    }
    this.engine.setScenario(name)
    return { status: 200, body: { scenario: name, state: this.engine.state } }
  }

  private patchState({ body }: RequestContext): JsonResponse {
    const result = validateStatePatch(body)
    if (!result.ok || !result.value) {
      return { status: 400, body: { error: 'Invalid state patch', problems: result.problems } }
    }
    this.engine.patchState(result.value)
    return { status: 200, body: { applied: result.value, state: this.engine.state } }
  }

  private updateInstrument({ params, body }: RequestContext): JsonResponse {
    const result = validateInstrumentUpdate(params[0] ?? '', body)
    if (!result.ok || !result.value) {
      return { status: 400, body: { error: 'Invalid instrument update', problems: result.problems } }
    }
    const { instrument, enabled, fault } = result.value
    if (enabled !== undefined) this.engine.setInstrumentEnabled(instrument, enabled)
    if (fault !== undefined) this.engine.setInstrumentFault(instrument, fault)
    return { status: 200, body: { instruments: this.engine.instrumentStatus() } }
  }

  private applyFault({ body }: RequestContext): JsonResponse {
    const result = validateFaultAction(body)
    if (!result.ok || !result.value) {
      return { status: 400, body: { error: 'Invalid fault action', problems: result.problems } }
    }
    this.engine.applyFault(result.value)
    return { status: 200, body: { applied: result.value, faults: this.engine.simulationWorld.faults.snapshot() } }
  }

  private setSentenceRate({ params, body }: RequestContext): JsonResponse {
    const result = validateSentenceRate(params[0] ?? '', body)
    if (!result.ok || !result.value) {
      return { status: 400, body: { error: 'Invalid sentence rate', problems: result.problems } }
    }
    this.engine.setSentenceRate(result.value.id, result.value.hz)
    return { status: 200, body: { sentenceRatesHz: this.engine.config.sentenceRatesHz } }
  }
}

type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string }

/** Read and parse a JSON body, refusing anything oversized or malformed. */
async function readJsonBody(request: http.IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = []
  let total = 0

  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      total += buffer.length
      if (total > MAX_BODY_BYTES) {
        return { ok: false, status: 413, error: `Request body exceeds ${MAX_BODY_BYTES} bytes` }
      }
      chunks.push(buffer)
    }
  } catch {
    return { ok: false, status: 400, error: 'Failed to read request body' }
  }

  if (total === 0) return { ok: true, value: undefined }

  const contentType = request.headers['content-type'] ?? ''
  if (contentType !== '' && !contentType.includes('application/json')) {
    return { ok: false, status: 415, error: 'Content-Type must be application/json' }
  }

  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { ok: false, status: 400, error: 'Request body is not valid JSON' }
  }
}
