/**
 * Optional NMEA 0183 over UDP.
 *
 * Some gateways broadcast rather than accept connections. This transport is
 * disabled by default and exists mainly to demonstrate that the engine is
 * genuinely transport-independent: it consumes the same encoded sentences the
 * TCP server does, with no changes anywhere upstream.
 */

import dgram from 'node:dgram'
import type { SentenceTransport, TransportStats } from './transport.js'

export interface UdpTransportOptions {
  host: string
  port: number
  /** Send to the subnet broadcast address rather than a single host. */
  broadcast?: boolean
  onError?: (error: Error) => void
}

export class NmeaUdpTransport implements SentenceTransport {
  readonly name = 'udp'

  private socket: dgram.Socket | null = null

  private sentencesSent = 0

  private bytesSent = 0

  private dropped = 0

  constructor(private readonly options: UdpTransportOptions) {}

  start(): Promise<void> {
    if (this.socket) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      socket.once('error', reject)
      socket.bind(() => {
        socket.off('error', reject)
        if (this.options.broadcast) socket.setBroadcast(true)
        socket.on('error', (error) => {
          this.dropped += 1
          this.options.onError?.(error)
        })
        this.socket = socket
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return Promise.resolve()
    return new Promise((resolve) => socket.close(() => resolve()))
  }

  broadcast(sentence: string): void {
    const socket = this.socket
    if (!socket) return
    const payload = Buffer.from(sentence, 'ascii')
    socket.send(payload, this.options.port, this.options.host, (error) => {
      if (error) {
        this.dropped += 1
        return
      }
      this.sentencesSent += 1
      this.bytesSent += payload.length
    })
  }

  stats(): TransportStats {
    return {
      name: this.name,
      listening: this.socket !== null,
      // UDP has no connections; the single destination counts as one.
      clients: this.socket ? 1 : 0,
      sentencesSent: this.sentencesSent,
      bytesSent: this.bytesSent,
      dropped: this.dropped,
    }
  }
}
