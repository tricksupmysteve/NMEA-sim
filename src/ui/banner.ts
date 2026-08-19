/**
 * Startup banner.
 *
 * The single most common reason a phone cannot reach the simulator is that the
 * user guessed the wrong address, so the banner prints every usable LAN address
 * with the port already attached — ready to paste into Matey.
 */

import { findLanAddresses, primaryLanAddress } from '../core/net.js'
import { PROFILES } from '../nmea0183/profiles.js'
import { getScenario } from '../scenarios/index.js'
import { activeSentenceIds, type SimulatorConfig } from '../config.js'

const RULE = '─'.repeat(52)

export interface BannerAddresses {
  tcp: { host: string; port: number } | null
  http: { host: string; port: number } | null
}

export function renderBanner(config: SimulatorConfig, addresses: BannerAddresses): string {
  const lines: string[] = []
  const tcpPort = addresses.tcp?.port ?? config.nmea.port

  lines.push('')
  lines.push('Matey NMEA Simulator')
  lines.push(RULE)
  lines.push('')
  lines.push(field('Scenario', `${config.scenario} — ${getScenario(config.scenario).label}`))
  lines.push(field('Profile', `${config.profile} (${PROFILES[config.profile].sentences.length} sentences)`))
  lines.push(field('Seed', String(config.seed)))
  lines.push(field('NMEA TCP', `${config.nmea.host}:${tcpPort}`))
  lines.push(
    field('HTTP', config.http.enabled ? `${config.http.host}:${addresses.http?.port ?? config.http.port}` : 'disabled'),
  )
  if (config.udp.enabled) {
    lines.push(field('UDP', `${config.udp.host}:${config.udp.port}`))
  }
  lines.push('')

  const lan = findLanAddresses().filter((entry) => entry.family === 'IPv4')
  lines.push('Local connections:')
  if (lan.length > 0) {
    for (const entry of lan) {
      lines.push(`  ${entry.address}:${tcpPort}   (${entry.interfaceName})`)
    }
  } else {
    lines.push('  no non-loopback IPv4 address found')
    lines.push('  on macOS, try:  ipconfig getifaddr en0')
  }
  lines.push('')

  const primary = primaryLanAddress()
  if (primary) {
    lines.push(`Point Matey (or any NMEA client) at:  ${primary}:${tcpPort}`)
    lines.push(`Verify from a terminal with:          nc ${primary} ${tcpPort}`)
  } else {
    lines.push(`Verify from a terminal with:          nc 127.0.0.1 ${tcpPort}`)
  }

  if (config.nmea.host === '127.0.0.1' || config.nmea.host === 'localhost') {
    lines.push('')
    lines.push('WARNING: bound to loopback only — devices on the LAN cannot connect.')
    lines.push('         Set NMEA_HOST=0.0.0.0 to accept connections from your phone.')
  }

  lines.push('')
  lines.push(`Sentences: ${activeSentenceIds(config).join(' ')}`)
  lines.push('')
  return lines.join('\n')
}

function field(label: string, value: string): string {
  return `${label.padEnd(14)}${value}`
}
