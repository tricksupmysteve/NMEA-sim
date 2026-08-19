import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ControlApiServer } from '../src/api/server.js'
import { validateFaultAction, validateInstrumentUpdate, validateSentenceRate, validateStatePatch } from '../src/api/validation.js'
import { silentLogger } from '../src/core/logger.js'
import { createTestEngine, requestJson, type TestEngine } from './helpers.js'

describe('validation', () => {
  it('accepts a well-formed state patch', () => {
    const result = validateStatePatch({ wind: { trueSpeedKnots: 18, trueDirectionDegrees: 240 } })
    assert.ok(result.ok)
    assert.deepEqual(result.value, { wind: { trueSpeedKnots: 18, trueDirectionDegrees: 240 } })
  })

  it('rejects a body that is not an object', () => {
    for (const body of [null, 42, 'nope', [1, 2, 3]]) {
      assert.equal(validateStatePatch(body).ok, false)
    }
  })

  it('rejects values that are not finite numbers', () => {
    const result = validateStatePatch({ wind: { trueSpeedKnots: 'fast' } })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((problem) => problem.includes('finite number')))
  })

  it('rejects out-of-range values with a helpful message', () => {
    const result = validateStatePatch({ position: { latitude: 120 } })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((problem) => problem.includes('between -90 and 90')))
  })

  it('rejects unknown fields rather than silently ignoring them', () => {
    const result = validateStatePatch({ wind: { gustKnots: 30 } })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((problem) => problem.includes('not a recognised field')))
  })

  it('reports every problem at once', () => {
    const result = validateStatePatch({ position: { latitude: 120, longitude: 400 }, wind: { trueSpeedKnots: -5 } })
    assert.equal(result.ok, false)
    assert.ok(result.problems.length >= 3, `only reported ${result.problems.length}`)
  })

  it('rejects an empty patch', () => {
    assert.equal(validateStatePatch({}).ok, false)
  })

  it('validates instrument updates', () => {
    assert.ok(validateInstrumentUpdate('wind', { enabled: false }).ok)
    assert.ok(validateInstrumentUpdate('gps', { fault: 'offline' }).ok)
    assert.equal(validateInstrumentUpdate('nonesuch', { enabled: false }).ok, false)
    assert.equal(validateInstrumentUpdate('wind', { fault: 'exploded' }).ok, false)
    assert.equal(validateInstrumentUpdate('wind', { enabled: 'yes' }).ok, false)
    assert.equal(validateInstrumentUpdate('wind', {}).ok, false, 'nothing to change')
  })

  it('validates fault actions', () => {
    assert.ok(validateFaultAction({ type: 'badChecksum', count: 3 }).ok)
    assert.ok(validateFaultAction({ type: 'malformed', probability: 0.1, durationSeconds: 30 }).ok)
    assert.ok(validateFaultAction({ type: 'clearAll' }).ok)
    assert.ok(validateFaultAction({ type: 'instrument', instrument: 'depth', fault: 'frozen' }).ok)

    assert.equal(validateFaultAction({ type: 'unknown' }).ok, false)
    assert.equal(validateFaultAction({ type: 'badChecksum' }).ok, false, 'needs count or probability')
    assert.equal(validateFaultAction({ type: 'badChecksum', probability: 5 }).ok, false)
    assert.equal(validateFaultAction({ type: 'instrument', instrument: 'radar', fault: 'none' }).ok, false)
  })

  it('validates sentence rates', () => {
    const result = validateSentenceRate('hdt', { hz: 10 })
    assert.ok(result.ok)
    assert.deepEqual(result.value, { id: 'HDT', hz: 10 })

    assert.equal(validateSentenceRate('nope', { hz: 1 }).ok, false)
    assert.equal(validateSentenceRate('HDT', { hz: 500 }).ok, false)
    assert.equal(validateSentenceRate('HDT', {}).ok, false)
  })
})

describe('control API', () => {
  let harness: TestEngine
  let api: ControlApiServer
  let port: number

  before(async () => {
    harness = await createTestEngine({ env: { SIM_SCENARIO: 'sailing' } })
    api = new ControlApiServer(harness.engine, {
      host: '127.0.0.1',
      port: 0,
      token: null,
      corsOrigin: '*',
      logger: silentLogger,
    })
    await api.start()
    port = api.address()?.port ?? 0
    assert.ok(port > 0)
    harness.advance(5_000)
  })

  after(async () => {
    await api.stop()
    await harness.stop()
  })

  it('GET /health reports the running scenario', async () => {
    const response = await requestJson(port, 'GET', '/health')
    assert.equal(response.status, 200)
    assert.equal(response.body.status, 'ok')
    assert.equal(response.body.scenario, 'sailing')
    assert.equal(response.body.seed, 12345)
    assert.ok(response.body.sentencesEmitted > 0)
  })

  it('GET /state returns the boat state, instrument ages and sentence ages', async () => {
    const response = await requestJson(port, 'GET', '/state')
    assert.equal(response.status, 200)

    const state = response.body.state
    assert.ok(Number.isFinite(state.position.latitude))
    assert.ok(Number.isFinite(state.navigation.sogKnots))
    assert.ok(Number.isFinite(state.wind.apparentSpeedKnots))
    assert.ok(Number.isFinite(state.environment.depthMeters))
    assert.ok(typeof state.timestamp === 'string')

    const instruments: Array<{ id: string; ageMs: number | null; sampleRateHz: number }> = response.body.instruments
    assert.ok(instruments.length >= 8)
    const wind = instruments.find((instrument) => instrument.id === 'wind')
    const temperature = instruments.find((instrument) => instrument.id === 'temperature')
    assert.ok(wind && temperature)
    assert.ok(wind.sampleRateHz > temperature.sampleRateHz, 'instruments run at different rates')

    const sentences: Array<{ id: string; hz: number; ageMs: number | null }> = response.body.sentences
    assert.ok(sentences.some((sentence) => sentence.id === 'HDT' && sentence.hz === 5))
    assert.ok(sentences.some((sentence) => sentence.id === 'MTW' && sentence.hz === 0.2))
  })

  it('GET /config reports the effective configuration without secrets', async () => {
    const response = await requestJson(port, 'GET', '/config')
    assert.equal(response.status, 200)
    assert.equal(response.body.profile, 'garmin-wifi')
    assert.equal(response.body.seed, 12345)
    assert.ok(response.body.sentenceRatesHz.RMC === 1)
    assert.equal(response.body.http.authRequired, false)
    assert.equal(response.body.http.token, undefined, 'the token is never echoed back')
    assert.ok(Array.isArray(response.body.lanAddresses))
  })

  it('GET /scenarios lists every scenario and marks the active one', async () => {
    const response = await requestJson(port, 'GET', '/scenarios')
    assert.equal(response.status, 200)
    assert.equal(response.body.active, 'sailing')
    const names = response.body.scenarios.map((scenario: { name: string }) => scenario.name)
    assert.deepEqual(names.sort(), ['anchored', 'cruising', 'sailing', 'sensor-failure', 'storm'])
  })

  it('GET /sentences lists the catalogue with rates and PGN mappings', async () => {
    const response = await requestJson(port, 'GET', '/sentences')
    assert.equal(response.status, 200)
    const hdt = response.body.sentences.find((sentence: { id: string }) => sentence.id === 'HDT')
    assert.ok(hdt)
    assert.equal(hdt.active, true)
    assert.equal(hdt.talker, 'II')
    assert.ok(hdt.nmea2000Pgns.includes(127250))

    const vdm = response.body.sentences.find((sentence: { id: string }) => sentence.id === 'VDM')
    assert.equal(vdm.active, false, 'AIS is not in the default profile')
  })

  it('GET /instruments and /clients and /metrics respond', async () => {
    assert.equal((await requestJson(port, 'GET', '/instruments')).status, 200)
    const clients = await requestJson(port, 'GET', '/clients')
    assert.equal(clients.status, 200)
    assert.deepEqual(clients.body.clients, [])
    const metrics = await requestJson(port, 'GET', '/metrics')
    assert.equal(metrics.status, 200)
    assert.ok(metrics.body.sentencesEmitted > 0)
  })

  it('GET / documents the available routes', async () => {
    const response = await requestJson(port, 'GET', '/')
    assert.equal(response.status, 200)
    assert.ok(response.body.routes['GET /health'])
    assert.ok(response.body.routes['POST /scenario/:name'])
  })

  it('POST /scenario/:name switches scenario', async () => {
    const response = await requestJson(port, 'POST', '/scenario/anchored')
    assert.equal(response.status, 200)
    assert.equal(response.body.scenario, 'anchored')
    assert.equal(harness.engine.currentScenario, 'anchored')

    harness.advance(10_000)
    assert.ok(harness.engine.state.navigation.sogKnots < 2, 'the new scenario really took effect')

    await requestJson(port, 'POST', '/scenario/sailing')
    assert.equal(harness.engine.currentScenario, 'sailing')
  })

  it('POST /scenario/:name rejects an unknown scenario', async () => {
    const response = await requestJson(port, 'POST', '/scenario/hurricane')
    assert.equal(response.status, 404)
    assert.ok(Array.isArray(response.body.available))
  })

  it('PATCH /state applies a validated override', async () => {
    const response = await requestJson(port, 'PATCH', '/state', {
      wind: { trueSpeedKnots: 18, trueDirectionDegrees: 240 },
    })
    assert.equal(response.status, 200)
    assert.ok(Math.abs(response.body.state.wind.trueSpeedKnots - 18) < 0.01)
    assert.ok(Math.abs(response.body.state.wind.trueDirectionDegrees - 240) < 0.01)

    // And the apparent wind must follow, rather than being set independently.
    harness.advance(1_000)
    const apparent = harness.engine.state.wind.apparentSpeedKnots
    const bound = harness.engine.state.wind.trueSpeedKnots + harness.engine.state.navigation.sogKnots
    assert.ok(apparent <= bound + 0.01)
  })

  it('PATCH /state rejects invalid input with the reasons', async () => {
    const response = await requestJson(port, 'PATCH', '/state', { wind: { trueSpeedKnots: -4 } })
    assert.equal(response.status, 400)
    assert.equal(response.body.error, 'Invalid state patch')
    assert.ok(response.body.problems.length > 0)
  })

  it('PATCH /state moves the boat', async () => {
    const response = await requestJson(port, 'PATCH', '/state', {
      position: { latitude: -33.85, longitude: 151.21 },
    })
    assert.equal(response.status, 200)
    assert.ok(Math.abs(response.body.state.position.latitude + 33.85) < 0.01)
    assert.ok(Math.abs(response.body.state.position.longitude - 151.21) < 0.01)
  })

  it('POST /instruments/:id disables and re-enables an instrument', async () => {
    const disabled = await requestJson(port, 'POST', '/instruments/depth', { enabled: false })
    assert.equal(disabled.status, 200)
    assert.equal(
      disabled.body.instruments.find((instrument: { id: string }) => instrument.id === 'depth').enabled,
      false,
    )

    const enabled = await requestJson(port, 'POST', '/instruments/depth', { enabled: true })
    assert.equal(
      enabled.body.instruments.find((instrument: { id: string }) => instrument.id === 'depth').enabled,
      true,
    )
  })

  it('POST /instruments/:id sets a fault', async () => {
    const response = await requestJson(port, 'POST', '/instruments/wind', { fault: 'frozen' })
    assert.equal(response.status, 200)
    assert.equal(response.body.instruments.find((instrument: { id: string }) => instrument.id === 'wind').fault, 'frozen')
    await requestJson(port, 'POST', '/instruments/wind', { fault: 'none' })
  })

  it('POST /instruments/:id rejects nonsense', async () => {
    assert.equal((await requestJson(port, 'POST', '/instruments/radar', { enabled: false })).status, 400)
    assert.equal((await requestJson(port, 'POST', '/instruments/wind', { fault: 'melted' })).status, 400)
  })

  it('POST /faults injects and clears a fault', async () => {
    const injected = await requestJson(port, 'POST', '/faults', { type: 'badChecksum', count: 4 })
    assert.equal(injected.status, 200)
    assert.equal(injected.body.faults.badChecksumRemaining, 4)

    const cleared = await requestJson(port, 'POST', '/faults', { type: 'clearAll' })
    assert.equal(cleared.body.faults.badChecksumRemaining, 0)
  })

  it('POST /sentences/:id/rate changes and removes a sentence', async () => {
    const changed = await requestJson(port, 'POST', '/sentences/HDT/rate', { hz: 10 })
    assert.equal(changed.status, 200)
    assert.equal(changed.body.sentenceRatesHz.HDT, 10)

    const removed = await requestJson(port, 'POST', '/sentences/HDT/rate', { hz: 0 })
    assert.equal(removed.body.sentenceRatesHz.HDT, undefined)

    await requestJson(port, 'POST', '/sentences/HDT/rate', { hz: 5 })
  })

  it('rejects a body that is not JSON', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/state`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(response.status, 400)
  })

  it('rejects a body with the wrong content type', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/state`, {
      method: 'PATCH',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal(response.status, 415)
  })

  it('rejects an oversized body', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/state`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wind: { note: 'x'.repeat(100_000) } }),
    })
    assert.equal(response.status, 413)
  })

  it('returns 404 for an unknown route and 405 for the wrong method', async () => {
    assert.equal((await requestJson(port, 'GET', '/nonesuch')).status, 404)
    const wrongMethod = await requestJson(port, 'POST', '/health')
    assert.equal(wrongMethod.status, 405)
    assert.deepEqual(wrongMethod.body.allowed, ['GET'])
  })

  it('answers a CORS preflight', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/state`, { method: 'OPTIONS' })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
  })

  it('tolerates a trailing slash', async () => {
    assert.equal((await requestJson(port, 'GET', '/health/')).status, 200)
  })
})

describe('control API with a token', () => {
  it('requires a bearer token everywhere except /health', async () => {
    const harness = await createTestEngine()
    const api = new ControlApiServer(harness.engine, {
      host: '127.0.0.1',
      port: 0,
      token: 'sekrit',
      corsOrigin: '*',
      logger: silentLogger,
    })
    await api.start()
    const port = api.address()?.port ?? 0

    try {
      assert.equal((await requestJson(port, 'GET', '/health')).status, 200, 'health stays open for platform checks')
      assert.equal((await requestJson(port, 'GET', '/state')).status, 401)
      assert.equal(
        (await requestJson(port, 'GET', '/state', undefined, { authorization: 'Bearer wrong' })).status,
        401,
      )
      assert.equal(
        (await requestJson(port, 'GET', '/state', undefined, { authorization: 'Bearer sekrit' })).status,
        200,
      )
    } finally {
      await api.stop()
      await harness.stop()
    }
  })
})
