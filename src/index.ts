#!/usr/bin/env node
/**
 * Entry point.
 *
 * Starts the NMEA TCP server, the optional HTTP control API and the console
 * dashboard, then shuts all three down cleanly on SIGTERM/SIGINT — which is
 * what a container platform such as Railway sends, and what Ctrl-C sends on a
 * Mac.
 */

import { ConfigError, loadConfig, type SimulatorConfig } from './config.js'
import { ControlApiServer } from './api/server.js'
import { SimulatorEngine } from './engine.js'
import { listScenarios } from './scenarios/index.js'
import { PROFILES, PROFILE_NAMES } from './nmea0183/profiles.js'
import { allSentenceDefinitions } from './nmea0183/registry.js'
import { renderBanner } from './ui/banner.js'
import { Dashboard } from './ui/dashboard.js'

const VERSION = '1.0.0'

const HELP = `
Matey NMEA Simulator ${VERSION}

Generates a live, internally consistent NMEA 0183 stream over raw TCP.

Usage
  npm run dev
  npm run sim -- --scenario sailing
  npm run sim -- --scenario storm --port 39150 --seed 12345

Options
  -s, --scenario <name>   Scenario to run (default: sailing)
      --profile <name>    Output profile (default: garmin-wifi)
  -p, --port <port>       NMEA TCP port (default: 39150)
      --host <address>    NMEA TCP bind address (default: 0.0.0.0)
      --http-port <port>  HTTP control API port (default: 3000, or $PORT)
      --no-http           Do not start the HTTP control API
      --seed <number>     Seed for repeatable runs (default: 12345)
      --time-scale <n>    Speed up or slow down simulated time (default: 1)
      --enable <list>     Comma-separated instruments to enable
      --disable <list>    Comma-separated instruments to disable
      --udp               Also broadcast over UDP
  -v, --verbose           Print every sentence as it is transmitted
      --quiet             Suppress the banner and dashboard
      --list-scenarios    Print the available scenarios and exit
      --list-sentences    Print the sentence catalogue and exit
      --version           Print the version and exit
  -h, --help              Print this help and exit

Environment variables are documented in .env.example and the README.
`.trim()

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${HELP}\n`)
    return
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (argv.includes('--list-scenarios')) {
    printScenarios()
    return
  }
  if (argv.includes('--list-sentences')) {
    printSentences()
    return
  }

  let config: SimulatorConfig
  try {
    config = loadConfig({ argv })
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n\nRun with --help for usage.\n`)
      process.exitCode = 2
      return
    }
    throw error
  }

  const engine = new SimulatorEngine(config)
  const api = config.http.enabled
    ? new ControlApiServer(engine, {
        host: config.http.host,
        port: config.http.port,
        token: config.http.token,
        corsOrigin: config.http.corsOrigin,
        logger: engine.logger,
      })
    : null

  await engine.start()
  if (api) await api.start()

  const tcp = engine.tcpAddress()
  engine.logger.write(`NMEA TCP server listening on ${config.nmea.host}:${tcp?.port ?? config.nmea.port}`)
  if (api) {
    engine.logger.write(`HTTP control API listening on ${config.http.host}:${api.address()?.port ?? config.http.port}`)
  }

  if (!config.quiet) {
    process.stdout.write(`${renderBanner(config, { tcp, http: api?.address() ?? null })}\n`)
  }

  const dashboard = config.quiet ? null : new Dashboard(engine, config.statusIntervalMs)
  dashboard?.start()

  installShutdownHandlers(async () => {
    dashboard?.stop()
    if (api) await api.stop()
    await engine.stop()
  }, engine.logger.write.bind(engine.logger))
}

/**
 * Graceful shutdown.
 *
 * The first signal starts an orderly stop; a second one gives up and exits
 * immediately, so a wedged socket can never leave the process unkillable. A
 * watchdog does the same after five seconds.
 */
function installShutdownHandlers(shutdown: () => Promise<void>, write: (line: string) => void): void {
  let shuttingDown = false

  const handle = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      write(`Received ${signal} again — exiting immediately.`)
      process.exit(130)
    }
    shuttingDown = true
    write(`Received ${signal} — shutting down.`)

    const watchdog = setTimeout(() => {
      write('Shutdown timed out — exiting.')
      process.exit(1)
    }, 5_000)
    watchdog.unref?.()

    shutdown()
      .then(() => {
        clearTimeout(watchdog)
        write('Shutdown complete.')
        process.exit(0)
      })
      .catch((error: unknown) => {
        clearTimeout(watchdog)
        write(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      })
  }

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, handle)
  }

  process.on('unhandledRejection', (reason) => {
    write(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
    handle('SIGTERM')
  })
  process.on('uncaughtException', (error) => {
    write(`Uncaught exception: ${error.stack ?? error.message}`)
    handle('SIGTERM')
  })
}

function printScenarios(): void {
  const lines = ['', 'Available scenarios', '']
  for (const scenario of listScenarios()) {
    lines.push(`  ${scenario.name.padEnd(16)}${scenario.label}`)
    lines.push(`  ${' '.repeat(16)}${scenario.description}`)
    lines.push(`  ${' '.repeat(16)}${scenario.highlights.join(' · ')}`)
    lines.push('')
  }
  lines.push('Profiles')
  lines.push('')
  for (const name of PROFILE_NAMES) {
    lines.push(`  ${name.padEnd(18)}${PROFILES[name].description}`)
  }
  lines.push('')
  process.stdout.write(`${lines.join('\n')}\n`)
}

function printSentences(): void {
  const lines = ['', 'Sentence catalogue', '']
  for (const definition of allSentenceDefinitions()) {
    lines.push(
      `  ${definition.id.padEnd(6)}${definition.defaultTalker}  ${String(definition.defaultHz).padStart(4)} Hz  ` +
        `${definition.description}`,
    )
    if (definition.pgns && definition.pgns.length > 0) {
      lines.push(`  ${' '.repeat(20)}NMEA 2000: ${definition.pgns.join(', ')}`)
    }
  }
  lines.push('')
  process.stdout.write(`${lines.join('\n')}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  process.exit(1)
})
