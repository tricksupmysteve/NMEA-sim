/**
 * Raw NMEA 0183 over TCP.
 *
 * This is the interface a marine NMEA-over-Wi-Fi gateway presents: connect a
 * socket, receive a continuous stream of sentences, send nothing. Anything a
 * client does send is read and discarded so its receive buffer never stalls.
 *
 * Slow clients are the interesting failure mode. A phone on a weak Wi-Fi link,
 * or a debugger paused at a breakpoint, stops draining its socket while the
 * simulator keeps producing five sentences a second. Node will happily queue
 * those writes in memory for ever. This server does not: it watches
 * `writableLength` and drops sentences for a backed-up client, then disconnects
 * it entirely if it stays backed up. A stalled consumer degrades its own feed
 * and nobody else's, and the process memory stays flat.
 */

import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { SentenceTransport, TransportStats } from './transport.js'

export interface TcpServerOptions {
  host: string
  port: number
  /**
   * Per-client socket backlog, in bytes, above which sentences are dropped for
   * that client. One second of the default profile is well under 1 KB, so the
   * default here tolerates a multi-second stall before shedding anything.
   */
  highWaterMarkBytes?: number
  /** Backlog above which the client is disconnected outright. */
  hardLimitBytes?: number
  /** Maximum simultaneous clients; further connections are refused. */
  maxClients?: number
  /** Seconds of TCP keep-alive idle time before probing a silent peer. */
  keepAliveDelayMs?: number
  /** Milliseconds to wait for clients to finish during shutdown. */
  shutdownGraceMs?: number
  onListening?: (address: { host: string; port: number }) => void
  onClientConnect?: (client: TcpClientInfo) => void
  onClientDisconnect?: (client: TcpClientInfo, reason: string) => void
  onError?: (error: Error, client?: TcpClientInfo) => void
}

export interface TcpClientInfo {
  id: number
  remoteAddress: string
  remotePort: number
  connectedAt: Date
  sentencesSent: number
  bytesSent: number
  dropped: number
}

interface TcpClient extends TcpClientInfo {
  socket: net.Socket
  /** Consecutive broadcasts during which this client was over the high-water mark. */
  congestedRounds: number
}

const DEFAULTS = {
  highWaterMarkBytes: 256 * 1024,
  hardLimitBytes: 2 * 1024 * 1024,
  maxClients: 64,
  keepAliveDelayMs: 30_000,
  shutdownGraceMs: 1_000,
} as const

export class NmeaTcpServer implements SentenceTransport {
  readonly name = 'tcp'

  private readonly server: net.Server

  private readonly clients = new Map<number, TcpClient>()

  private nextClientId = 1

  private listening = false

  private totalSentences = 0

  private totalBytes = 0

  private totalDropped = 0

  private readonly options: Required<Omit<TcpServerOptions, 'onListening' | 'onClientConnect' | 'onClientDisconnect' | 'onError'>> &
    Pick<TcpServerOptions, 'onListening' | 'onClientConnect' | 'onClientDisconnect' | 'onError'>

  constructor(options: TcpServerOptions) {
    this.options = { ...DEFAULTS, ...options }
    this.server = net.createServer({ noDelay: true }, (socket) => this.handleConnection(socket))
    this.server.on('error', (error) => this.options.onError?.(error))
  }

  /** The address actually bound. Meaningful only after `start()` resolves. */
  address(): { host: string; port: number } | null {
    const address = this.server.address() as AddressInfo | string | null
    if (!address || typeof address === 'string') return null
    return { host: address.address, port: address.port }
  }

  get clientCount(): number {
    return this.clients.size
  }

  listClients(): TcpClientInfo[] {
    return [...this.clients.values()].map(({ socket: _socket, congestedRounds: _congested, ...info }) => ({ ...info }))
  }

  start(): Promise<void> {
    if (this.listening) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.server.off('error', onError)
        this.listening = true
        const address = this.address()
        if (address) this.options.onListening?.(address)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.options.port, this.options.host)
    })
  }

  /**
   * Stop accepting connections and close existing ones.
   *
   * Clients are asked to finish politely first; any socket still open after the
   * grace period is destroyed so shutdown cannot hang on a wedged peer.
   */
  async stop(): Promise<void> {
    this.listening = false

    for (const client of this.clients.values()) {
      client.socket.end()
    }

    const closed = new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })

    const grace = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const client of this.clients.values()) {
          client.socket.destroy()
        }
        resolve()
      }, this.options.shutdownGraceMs)
      timer.unref?.()
    })

    await Promise.race([closed, grace])
    // Make sure nothing is left holding the event loop open.
    for (const client of this.clients.values()) {
      client.socket.destroy()
    }
    this.clients.clear()
    await closed
  }

  /** Send one complete sentence to every connected client. */
  broadcast(sentence: string): void {
    if (this.clients.size === 0) return
    const payload = Buffer.from(sentence, 'ascii')

    for (const client of this.clients.values()) {
      const socket = client.socket
      if (socket.destroyed || !socket.writable) continue

      // Backpressure: a client that is not draining must not be allowed to
      // grow an unbounded queue inside this process.
      if (socket.writableLength > this.options.hardLimitBytes) {
        this.disconnect(client, 'backpressure limit exceeded')
        continue
      }
      if (socket.writableLength > this.options.highWaterMarkBytes) {
        client.dropped += 1
        client.congestedRounds += 1
        this.totalDropped += 1
        if (client.congestedRounds > 2000) {
          this.disconnect(client, 'client persistently congested')
        }
        continue
      }

      client.congestedRounds = 0
      socket.write(payload)
      client.sentencesSent += 1
      client.bytesSent += payload.length
      this.totalSentences += 1
      this.totalBytes += payload.length
    }
  }

  stats(): TransportStats {
    return {
      name: this.name,
      listening: this.listening,
      clients: this.clients.size,
      sentencesSent: this.totalSentences,
      bytesSent: this.totalBytes,
      dropped: this.totalDropped,
    }
  }

  private handleConnection(socket: net.Socket): void {
    if (this.clients.size >= this.options.maxClients) {
      socket.destroy()
      return
    }

    const client: TcpClient = {
      id: this.nextClientId++,
      remoteAddress: socket.remoteAddress ?? 'unknown',
      remotePort: socket.remotePort ?? 0,
      connectedAt: new Date(),
      sentencesSent: 0,
      bytesSent: 0,
      dropped: 0,
      socket,
      congestedRounds: 0,
    }
    this.clients.set(client.id, client)

    socket.setNoDelay(true)
    socket.setKeepAlive(true, this.options.keepAliveDelayMs)

    // Clients are not required to send anything. Read and discard whatever
    // they do send so their data never backs up in the kernel buffer.
    socket.resume()
    socket.on('data', () => {})

    socket.on('error', (error: NodeJS.ErrnoException) => {
      // ECONNRESET and EPIPE are what a phone leaving Wi-Fi looks like; they
      // are routine, not failures of the server.
      if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') {
        this.options.onError?.(error, toInfo(client))
      }
      this.finalise(client, error.code ?? 'socket error')
    })

    socket.on('close', () => this.finalise(client, 'closed'))
    socket.on('end', () => this.finalise(client, 'ended'))

    this.options.onClientConnect?.(toInfo(client))
  }

  private disconnect(client: TcpClient, reason: string): void {
    client.socket.destroy()
    this.finalise(client, reason)
  }

  private finalise(client: TcpClient, reason: string): void {
    if (!this.clients.delete(client.id)) return
    this.options.onClientDisconnect?.(toInfo(client), reason)
  }
}

function toInfo(client: TcpClient): TcpClientInfo {
  const { socket: _socket, congestedRounds: _congested, ...info } = client
  return { ...info }
}
