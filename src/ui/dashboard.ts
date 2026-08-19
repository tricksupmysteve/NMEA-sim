/**
 * Console dashboard.
 *
 * Useful development logging without flooding the terminal: a compact block
 * refreshed on a timer rather than a line per sentence. On a TTY the block is
 * redrawn in place; in a non-interactive log (Docker, Railway) it is printed as
 * a single line so the log stays readable and greppable.
 *
 * Raw sentence logging is a separate, opt-in concern (`--verbose` / `LOG_NMEA`).
 */

import { primaryLanAddress } from '../core/net.js'
import type { SimulatorEngine } from '../engine.js'

const CURSOR_UP = (lines: number): string => `\u001b[${lines}A`
const CLEAR_BELOW = '\u001b[0J'

export class Dashboard {
  private timer: NodeJS.Timeout | null = null

  private lastLineCount = 0

  private readonly interactive: boolean

  constructor(
    private readonly engine: SimulatorEngine,
    private readonly intervalMs: number,
    private readonly write: (text: string) => void = (text) => process.stdout.write(text),
    isTty: boolean = process.stdout.isTTY === true,
  ) {
    // Never redraw in place when raw sentences are also being printed, or the
    // two would fight over the cursor.
    this.interactive = isTty && !engine.config.logNmea
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return
    this.timer = setInterval(() => this.render(), this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Render one frame. Exposed so tests can assert on the output. */
  render(): void {
    if (!this.interactive) {
      this.write(`${this.summaryLine()}\n`)
      return
    }
    const text = this.block()
    const reset = this.lastLineCount > 0 ? `${CURSOR_UP(this.lastLineCount)}${CLEAR_BELOW}` : ''
    this.lastLineCount = text.split('\n').length
    this.write(`${reset}${text}\n`)
  }

  /** The multi-line status block, without any cursor control sequences. */
  block(): string {
    const state = this.engine.state
    const stats = this.engine.stats()
    const tcp = this.engine.tcpAddress()
    const lan = primaryLanAddress()
    const clients = stats.transports.reduce((total, transport) => total + transport.clients, 0)
    const config = this.engine.config

    const lines: string[] = []
    lines.push('Matey NMEA Simulator')
    lines.push('─'.repeat(40))
    lines.push('')
    lines.push(field('Scenario', this.engine.currentScenario))
    lines.push(field('TCP', tcp ? `${config.nmea.host}:${tcp.port}` : 'stopped'))
    lines.push(field('HTTP', config.http.enabled ? `${config.http.host}:${config.http.port}` : 'disabled'))
    lines.push('')
    if (lan && tcp) {
      lines.push('LAN:')
      lines.push(`${lan}:${tcp.port}`)
      lines.push('')
    }
    lines.push(field('Clients', String(clients)))
    lines.push(field('Sentences', `${stats.sentencesEmitted} sent`))
    lines.push('')
    lines.push('Boat')
    lines.push(field('SOG', `${state.navigation.sogKnots.toFixed(1)} kn`))
    lines.push(field('STW', `${state.navigation.speedThroughWaterKnots.toFixed(1)} kn`))
    lines.push(field('COG', `${Math.round(state.navigation.cog)}°`))
    lines.push(field('Heading', `${Math.round(state.navigation.headingTrue)}°`))
    lines.push(field('Depth', `${state.environment.depthMeters.toFixed(1)} m`))
    lines.push('')
    lines.push('Wind')
    lines.push(field('AWS', `${state.wind.apparentSpeedKnots.toFixed(1)} kn`))
    lines.push(field('AWA', `${Math.round(state.wind.apparentAngleDegrees)}°`))
    lines.push(field('TWS', `${state.wind.trueSpeedKnots.toFixed(1)} kn`))
    lines.push(field('TWD', `${Math.round(state.wind.trueDirectionDegrees)}°`))

    const faulted = this.engine.instrumentStatus().filter((status) => status.fault !== 'none' || !status.enabled)
    if (faulted.length > 0) {
      lines.push('')
      lines.push('Instrument faults')
      for (const status of faulted) {
        lines.push(field(status.id, status.enabled ? status.fault : 'disabled'))
      }
    }

    return lines.join('\n')
  }

  /** The one-line form used in non-interactive logs. */
  summaryLine(): string {
    const state = this.engine.state
    const stats = this.engine.stats()
    const clients = stats.transports.reduce((total, transport) => total + transport.clients, 0)
    return [
      `scenario=${this.engine.currentScenario}`,
      `clients=${clients}`,
      `sent=${stats.sentencesEmitted}`,
      `sog=${state.navigation.sogKnots.toFixed(1)}kn`,
      `cog=${Math.round(state.navigation.cog)}`,
      `hdg=${Math.round(state.navigation.headingTrue)}`,
      `aws=${state.wind.apparentSpeedKnots.toFixed(1)}kn`,
      `awa=${Math.round(state.wind.apparentAngleDegrees)}`,
      `tws=${state.wind.trueSpeedKnots.toFixed(1)}kn`,
      `twd=${Math.round(state.wind.trueDirectionDegrees)}`,
      `depth=${state.environment.depthMeters.toFixed(1)}m`,
    ].join(' ')
  }
}

function field(label: string, value: string): string {
  return `${label.padEnd(15)}${value}`
}
