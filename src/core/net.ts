/**
 * Network address discovery.
 *
 * The simulator is normally reached from another device on the same Wi-Fi
 * network — a phone running Matey connecting to a Mac. Printing the machine's
 * usable LAN addresses at startup removes the most common source of "it will
 * not connect": guessing the wrong IP.
 */

import os from 'node:os'

export interface LanAddress {
  /** Interface name, e.g. `en0` on macOS. */
  interfaceName: string
  address: string
  family: 'IPv4' | 'IPv6'
}

/**
 * Non-loopback, non-internal addresses, IPv4 first.
 *
 * Link-local addresses (169.254/16 and fe80::/10) are excluded: they appear on
 * interfaces with no DHCP lease and never work for a phone on the LAN.
 */
export function findLanAddresses(): LanAddress[] {
  const addresses: LanAddress[] = []
  const interfaces = os.networkInterfaces()

  for (const [interfaceName, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      const family = normaliseFamily(entry.family)
      if (family === null) continue
      if (family === 'IPv4' && entry.address.startsWith('169.254.')) continue
      if (family === 'IPv6' && entry.address.toLowerCase().startsWith('fe80')) continue
      addresses.push({ interfaceName, address: entry.address, family })
    }
  }

  return addresses.sort((a, b) => {
    if (a.family !== b.family) return a.family === 'IPv4' ? -1 : 1
    return a.interfaceName.localeCompare(b.interfaceName)
  })
}

/** The single most likely address for another device on the LAN to use. */
export function primaryLanAddress(): string | null {
  const ipv4 = findLanAddresses().filter((entry) => entry.family === 'IPv4')
  // Prefer a private-range address; a public one is unlikely to be the LAN.
  const private4 = ipv4.find((entry) => isPrivateIPv4(entry.address))
  return (private4 ?? ipv4[0])?.address ?? null
}

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  const [a, b] = parts
  if (a === undefined || b === undefined || parts.length !== 4) return false
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function normaliseFamily(family: string | number): 'IPv4' | 'IPv6' | null {
  // Node reports the family as a string in modern versions and a number in
  // some older ones; accept both.
  if (family === 'IPv4' || family === 4) return 'IPv4'
  if (family === 'IPv6' || family === 6) return 'IPv6'
  return null
}
