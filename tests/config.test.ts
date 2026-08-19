import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, DEFAULT_HTTP_PORT, DEFAULT_NMEA_PORT, activeSentenceIds, loadConfig, parseEnvFile } from '../src/config.js'

const load = (env: Record<string, string> = {}, argv: string[] = []) =>
  loadConfig({ env, argv, envFileDir: null })

describe('defaults', () => {
  it('listens on all interfaces on port 39150', () => {
    const config = load()
    assert.equal(config.nmea.host, '0.0.0.0', 'binding to loopback would lock out phones on the LAN')
    assert.equal(config.nmea.port, DEFAULT_NMEA_PORT)
    assert.equal(config.nmea.port, 39150)
  })

  it('starts the HTTP API on port 3000', () => {
    const config = load()
    assert.equal(config.http.enabled, true)
    assert.equal(config.http.port, DEFAULT_HTTP_PORT)
    assert.equal(config.http.token, null)
  })

  it('runs the sailing scenario on the garmin-wifi profile with seed 12345', () => {
    const config = load()
    assert.equal(config.scenario, 'sailing')
    assert.equal(config.profile, 'garmin-wifi')
    assert.equal(config.seed, 12345)
  })

  it('uses the documented sentence rates', () => {
    const config = load()
    assert.deepEqual(config.sentenceRatesHz, {
      HDT: 5,
      MWV: 5,
      VHW: 2,
      RMC: 1,
      GGA: 1,
      VTG: 1,
      MWD: 1,
      DPT: 1,
      MTW: 0.2,
    })
  })

  it('enables every instrument except AIS', () => {
    const config = load()
    assert.equal(config.instrumentEnabled.gps, true)
    assert.equal(config.instrumentEnabled.wind, true)
    assert.equal(config.instrumentEnabled.depth, true)
    assert.equal(config.instrumentEnabled.waterSpeed, true)
    assert.equal(config.instrumentEnabled.temperature, true)
    assert.equal(config.instrumentEnabled.heading, true)
    assert.equal(config.instrumentEnabled.ais, false, 'AIS is optional and off by default')
  })

  it('samples instruments at rates independent of the sentence rates', () => {
    const config = load()
    assert.ok(config.instrumentIntervalsMs.heading < config.instrumentIntervalsMs.temperature)
    assert.notEqual(config.instrumentIntervalsMs.gps, 1000 / (config.sentenceRatesHz['RMC'] ?? 1))
  })

  it('leaves NMEA logging off', () => {
    assert.equal(load().logNmea, false)
  })
})

describe('environment variables', () => {
  it('honours the documented variables', () => {
    const config = load({
      NODE_ENV: 'production',
      NMEA_HOST: '127.0.0.1',
      NMEA_PORT: '10110',
      PORT: '8080',
      SIM_SCENARIO: 'storm',
      SIM_SEED: '999',
      ENABLE_GPS: 'false',
      ENABLE_WIND: 'no',
      ENABLE_DEPTH: '0',
      ENABLE_WATER_SPEED: 'off',
      ENABLE_TEMPERATURE: 'true',
      ENABLE_HEADING: '1',
      LOG_NMEA: 'true',
    })

    assert.equal(config.nodeEnv, 'production')
    assert.equal(config.nmea.host, '127.0.0.1')
    assert.equal(config.nmea.port, 10110)
    assert.equal(config.http.port, 8080, 'Railway injects PORT for the HTTP service')
    assert.equal(config.scenario, 'storm')
    assert.equal(config.seed, 999)
    assert.equal(config.instrumentEnabled.gps, false)
    assert.equal(config.instrumentEnabled.wind, false)
    assert.equal(config.instrumentEnabled.depth, false)
    assert.equal(config.instrumentEnabled.waterSpeed, false)
    assert.equal(config.instrumentEnabled.temperature, true)
    assert.equal(config.instrumentEnabled.heading, true)
    assert.equal(config.logNmea, true)
  })

  it('prefers PORT over HTTP_PORT, as Railway sets PORT', () => {
    assert.equal(load({ PORT: '4000', HTTP_PORT: '5000' }).http.port, 4000)
    assert.equal(load({ HTTP_PORT: '5000' }).http.port, 5000)
  })

  it('overrides a sentence rate and can switch one off', () => {
    const config = load({ NMEA_RATE_HDT: '10', NMEA_RATE_MTW: '0' })
    assert.equal(config.sentenceRatesHz['HDT'], 10)
    assert.equal(config.sentenceRatesHz['MTW'], undefined)
    assert.ok(!activeSentenceIds(config).includes('MTW'))
  })

  it('adds a sentence that the profile does not include', () => {
    const config = load({ NMEA_RATE_ZDA: '1' })
    assert.equal(config.sentenceRatesHz['ZDA'], 1)
    assert.ok(activeSentenceIds(config).includes('ZDA'))
  })

  it('overrides a sensor sampling interval', () => {
    assert.equal(load({ SENSOR_INTERVAL_WIND_MS: '50' }).instrumentIntervalsMs.wind, 50)
    assert.equal(load({ SENSOR_INTERVAL_WATER_SPEED_MS: '1000' }).instrumentIntervalsMs.waterSpeed, 1000)
  })

  it('reads an optional API token', () => {
    assert.equal(load({ API_TOKEN: 'sekrit' }).http.token, 'sekrit')
    assert.equal(load({ API_TOKEN: '   ' }).http.token, null)
  })

  it('parses a fixed start time', () => {
    const config = load({ SIM_START_TIME: '2026-03-14T09:26:53Z' })
    assert.equal(config.startEpochMs, Date.parse('2026-03-14T09:26:53Z'))
    assert.equal(load().startEpochMs, null)
  })
})

describe('command-line flags', () => {
  it('accepts --name value and --name=value', () => {
    assert.equal(load({}, ['--scenario', 'anchored']).scenario, 'anchored')
    assert.equal(load({}, ['--scenario=anchored']).scenario, 'anchored')
    assert.equal(load({}, ['--port', '4000']).nmea.port, 4000)
    assert.equal(load({}, ['--port=4000']).nmea.port, 4000)
  })

  it('accepts the short aliases', () => {
    assert.equal(load({}, ['-s', 'storm']).scenario, 'storm')
    assert.equal(load({}, ['-p', '5000']).nmea.port, 5000)
    assert.equal(load({}, ['-v']).logNmea, true)
  })

  it('overrides the environment', () => {
    const config = load({ SIM_SCENARIO: 'sailing', NMEA_PORT: '39150', SIM_SEED: '1' }, [
      '--scenario',
      'storm',
      '--port',
      '4000',
      '--seed',
      '777',
    ])
    assert.equal(config.scenario, 'storm')
    assert.equal(config.nmea.port, 4000)
    assert.equal(config.seed, 777)
  })

  it('supports the documented overrides together', () => {
    const config = load({}, ['--port', '39150', '--seed', '12345', '--scenario', 'sailing'])
    assert.equal(config.nmea.port, 39150)
    assert.equal(config.seed, 12345)
    assert.equal(config.scenario, 'sailing')
  })

  it('turns the HTTP API off with --no-http', () => {
    assert.equal(load({}, ['--no-http']).http.enabled, false)
  })

  it('enables and disables instruments by name', () => {
    const config = load({}, ['--disable', 'wind,depth', '--enable', 'ais'])
    assert.equal(config.instrumentEnabled.wind, false)
    assert.equal(config.instrumentEnabled.depth, false)
    assert.equal(config.instrumentEnabled.ais, true)
  })

  it('sets the HTTP port and the time scale', () => {
    const config = load({}, ['--http-port', '9000', '--time-scale', '5'])
    assert.equal(config.http.port, 9000)
    assert.equal(config.timeScale, 5)
  })

  it('accepts the camelCase spelling of the sensor-failure scenario', () => {
    assert.equal(load({}, ['--scenario', 'sensorFailure']).scenario, 'sensor-failure')
    assert.equal(load({}, ['--scenario', 'sensor-failure']).scenario, 'sensor-failure')
  })
})

describe('validation', () => {
  it('rejects an unknown scenario, naming the problem', () => {
    assert.throws(
      () => load({ SIM_SCENARIO: 'hurricane' }),
      (error: unknown) => error instanceof ConfigError && error.problems.some((problem) => problem.includes('hurricane')),
    )
  })

  it('rejects an unknown profile and lists the valid ones', () => {
    assert.throws(
      () => load({ NMEA_PROFILE: 'raymarine' }),
      (error: unknown) => error instanceof ConfigError && error.problems.some((problem) => problem.includes('garmin-wifi')),
    )
  })

  it('rejects a port that is not a number or is out of range', () => {
    assert.throws(() => load({ NMEA_PORT: 'abc' }), ConfigError)
    assert.throws(() => load({ NMEA_PORT: '70000' }), ConfigError)
    assert.throws(() => load({ NMEA_PORT: '-1' }), ConfigError)
  })

  it('rejects a non-boolean toggle', () => {
    assert.throws(
      () => load({ ENABLE_WIND: 'maybe' }),
      (error: unknown) => error instanceof ConfigError && error.problems.some((problem) => problem.includes('boolean')),
    )
  })

  it('rejects an unknown instrument name', () => {
    assert.throws(
      () => load({}, ['--disable', 'radar']),
      (error: unknown) => error instanceof ConfigError && error.problems.some((problem) => problem.includes('radar')),
    )
  })

  it('rejects an unknown sentence in a rate override', () => {
    assert.throws(() => load({ NMEA_RATE_ZZZ: '1' }), ConfigError)
  })

  it('rejects an invalid start time', () => {
    assert.throws(() => load({ SIM_START_TIME: 'yesterday' }), ConfigError)
  })

  it('collects every problem into one error', () => {
    try {
      load({ NMEA_PORT: 'abc', SIM_SCENARIO: 'nope', ENABLE_WIND: 'maybe' })
      assert.fail('expected a ConfigError')
    } catch (error) {
      assert.ok(error instanceof ConfigError)
      assert.ok(error.problems.length >= 3, `only reported ${error.problems.length}`)
      assert.ok(error.message.includes('Invalid configuration'))
    }
  })

  it('rejects a stray positional argument', () => {
    assert.throws(() => load({}, ['sailing']), ConfigError)
  })
})

describe('.env parsing', () => {
  it('reads KEY=value lines', () => {
    assert.deepEqual(parseEnvFile('NMEA_PORT=39150\nSIM_SEED=12345'), { NMEA_PORT: '39150', SIM_SEED: '12345' })
  })

  it('ignores comments and blank lines', () => {
    assert.deepEqual(parseEnvFile('# a comment\n\nNMEA_HOST=0.0.0.0\n   \n'), { NMEA_HOST: '0.0.0.0' })
  })

  it('strips surrounding quotes', () => {
    assert.deepEqual(parseEnvFile('A="one"\nB=\'two\''), { A: 'one', B: 'two' })
  })

  it('keeps equals signs inside the value', () => {
    assert.deepEqual(parseEnvFile('TOKEN=abc=def'), { TOKEN: 'abc=def' })
  })

  it('ignores malformed lines', () => {
    assert.deepEqual(parseEnvFile('no-equals-here\n=novalue\nOK=1'), { OK: '1' })
  })

  it('lets the real environment win over the file', () => {
    // The loader merges `.env` first and the process environment second.
    const config = loadConfig({ env: { NMEA_PORT: '1234' }, argv: [], envFileDir: null })
    assert.equal(config.nmea.port, 1234)
  })
})
