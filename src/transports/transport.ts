/**
 * Transport abstraction.
 *
 * The simulator produces sentences; a transport decides how they leave the
 * process. TCP is the transport Matey uses, but the engine only ever talks to
 * this interface, so UDP, a WebSocket, a serial port or a future NMEA 2000
 * gateway can be added without touching the simulation or the encoder.
 */

export interface TransportStats {
  name: string
  listening: boolean
  clients: number
  sentencesSent: number
  bytesSent: number
  /** Sentences dropped because a client could not keep up. */
  dropped: number
}

export interface SentenceTransport {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  /** Deliver one complete sentence (already terminated with CRLF). */
  broadcast(sentence: string): void
  stats(): TransportStats
}
