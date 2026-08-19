import assert from 'node:assert/strict'
import net from 'node:net'
import { describe, it } from 'node:test'
import { NmeaTcpServer } from '../src/transports/tcp.js'
import { formatSentence } from '../src/nmea0183/checksum.js'
import { connectClient, waitFor } from './helpers.js'

/**
 * The TCP server is the interface Matey actually connects to, so these tests
 * use real sockets on an ephemeral port rather than a mock.
 */

interface StartedServer {
  server: NmeaTcpServer
  port: number
  /** Connection events observed, in order. */
  connects: number[]
  disconnects: string[]
}

async function startServer(
  options: Partial<ConstructorParameters<typeof NmeaTcpServer>[0]> = {},
): Promise<StartedServer> {
  const connects: number[] = []
  const disconnects: string[] = []
  const server = new NmeaTcpServer({
    host: '127.0.0.1',
    port: 0,
    onClientConnect: (client) => connects.push(client.id),
    onClientDisconnect: (_client, reason) => disconnects.push(reason),
    ...options,
  })
  await server.start()
  const address = server.address()
  assert.ok(address, 'server did not bind')
  return { server, port: address.port, connects, disconnects }
}

describe('NMEA TCP server', () => {
  it('accepts a connection and streams sentences without being asked', async () => {
    const { server, port, connects, disconnects } = await startServer()
    const client = await connectClient(port)
    try {
      // The client sends nothing at all — data must arrive anyway.
      const sentence = formatSentence('IIHDT,145.0,T')
      await waitFor(() => server.clientCount === 1, 2_000, 'the client to register')
      server.broadcast(sentence)
      await client.waitForLines(1)
      assert.equal(client.lines[0], sentence)
      assert.equal(connects.length, 1, 'the connection was reported')
      assert.deepEqual(disconnects, [])
    } finally {
      await client.close()
      await server.stop()
    }
  })

  it('reports the address it bound to', async () => {
    const { server, port } = await startServer()
    try {
      assert.equal(server.address()?.host, '127.0.0.1')
      assert.ok(port > 0)
    } finally {
      await server.stop()
    }
  })

  it('delivers the same stream to several clients at once', async () => {
    const { server, port } = await startServer()
    const clients = await Promise.all([connectClient(port), connectClient(port), connectClient(port)])
    try {
      await waitFor(() => server.clientCount === 3, 2_000, 'three clients')

      const sentences = [formatSentence('IIHDT,145.0,T'), formatSentence('WIMTW,16.5,C'), formatSentence('SDDPT,12.0,0.6,')]
      for (const sentence of sentences) server.broadcast(sentence)

      await Promise.all(clients.map((client) => client.waitForLines(3)))
      for (const client of clients) {
        assert.deepEqual(client.lines.slice(0, 3), sentences)
      }
      assert.equal(server.listClients().length, 3)
    } finally {
      await Promise.all(clients.map((client) => client.close()))
      await server.stop()
    }
  })

  it('keeps serving the remaining clients when one disconnects', async () => {
    const { server, port, disconnects } = await startServer()
    const staying = await connectClient(port)
    const leaving = await connectClient(port)
    try {
      await waitFor(() => server.clientCount === 2)
      await leaving.close()
      await waitFor(() => server.clientCount === 1, 2_000, 'the departing client to be reaped')
      assert.equal(disconnects.length, 1, 'the disconnection was reported')

      const sentence = formatSentence('WIMWV,67.8,R,15.1,N,A')
      server.broadcast(sentence)
      await staying.waitForLines(1)
      assert.equal(staying.lines[0], sentence)
    } finally {
      await staying.close()
      await server.stop()
    }
  })

  it('accepts a client that reconnects', async () => {
    const { server, port } = await startServer()
    try {
      const first = await connectClient(port)
      await waitFor(() => server.clientCount === 1)
      server.broadcast(formatSentence('IIHDT,145.0,T'))
      await first.waitForLines(1)
      await first.close()
      await waitFor(() => server.clientCount === 0, 2_000, 'the first client to go')

      const second = await connectClient(port)
      await waitFor(() => server.clientCount === 1, 2_000, 'the reconnection')
      const sentence = formatSentence('IIHDT,146.0,T')
      server.broadcast(sentence)
      await second.waitForLines(1)
      assert.equal(second.lines[0], sentence)
      await second.close()
    } finally {
      await server.stop()
    }
  })

  it('survives many reconnections without leaking clients', async () => {
    const { server, port } = await startServer()
    try {
      for (let index = 0; index < 12; index += 1) {
        const client = await connectClient(port)
        await waitFor(() => server.clientCount === 1, 2_000, `connection ${index}`)
        server.broadcast(formatSentence('IIHDT,145.0,T'))
        await client.waitForLines(1)
        await client.close()
        await waitFor(() => server.clientCount === 0, 2_000, `disconnection ${index}`)
      }
      assert.equal(server.clientCount, 0)
    } finally {
      await server.stop()
    }
  })

  it('reads and discards anything a client sends', async () => {
    const { server, port } = await startServer()
    const client = await connectClient(port)
    try {
      await waitFor(() => server.clientCount === 1)
      client.socket.write('this is not an NMEA sentence\r\n'.repeat(500))
      await new Promise((resolve) => setTimeout(resolve, 50))

      const sentence = formatSentence('WIMTW,16.5,C')
      server.broadcast(sentence)
      await client.waitForLines(1)
      assert.equal(client.lines[0], sentence)
      assert.equal(server.clientCount, 1, 'the client is still connected')
    } finally {
      await client.close()
      await server.stop()
    }
  })

  it('drops sentences for a client that stops reading, rather than buffering without limit', async () => {
    const { server, port } = await startServer({ highWaterMarkBytes: 4096, hardLimitBytes: 1024 * 1024 })
    // Connect without ever draining: pausing the socket stops the receive
    // window from opening, so the server's write buffer grows.
    const socket = net.createConnection({ port, host: '127.0.0.1' })
    await new Promise((resolve) => socket.once('connect', resolve))
    socket.pause()

    try {
      await waitFor(() => server.clientCount === 1)
      const sentence = formatSentence(`IIHDT,145.0,T,${'9'.repeat(40)}`)
      for (let index = 0; index < 200_000; index += 1) {
        server.broadcast(sentence)
        if (server.stats().dropped > 0) break
      }

      const stats = server.stats()
      assert.ok(stats.dropped > 0, 'the server should shed data for a stalled client')
      const client = server.listClients()[0]
      assert.ok(client)
      assert.ok(client.dropped > 0)
    } finally {
      socket.destroy()
      await server.stop()
    }
  })

  it('refuses connections beyond the configured maximum', async () => {
    const { server, port } = await startServer({ maxClients: 2 })
    const accepted = [await connectClient(port), await connectClient(port)]
    try {
      await waitFor(() => server.clientCount === 2)

      const rejected = net.createConnection({ port, host: '127.0.0.1' })
      const closed = new Promise<void>((resolve) => rejected.once('close', () => resolve()))
      rejected.on('error', () => {})
      await closed

      assert.equal(server.clientCount, 2, 'the extra connection was refused')
    } finally {
      await Promise.all(accepted.map((client) => client.close()))
      await server.stop()
    }
  })

  it('counts what it has sent', async () => {
    const { server, port } = await startServer()
    const client = await connectClient(port)
    try {
      await waitFor(() => server.clientCount === 1)
      const sentence = formatSentence('IIHDT,145.0,T')
      for (let index = 0; index < 5; index += 1) server.broadcast(sentence)
      await client.waitForLines(5)

      const stats = server.stats()
      assert.equal(stats.name, 'tcp')
      assert.equal(stats.listening, true)
      assert.equal(stats.clients, 1)
      assert.equal(stats.sentencesSent, 5)
      assert.equal(stats.bytesSent, sentence.length * 5)
    } finally {
      await client.close()
      await server.stop()
    }
  })

  it('broadcasting with no clients is harmless', async () => {
    const { server } = await startServer()
    try {
      server.broadcast(formatSentence('IIHDT,145.0,T'))
      assert.equal(server.stats().sentencesSent, 0)
    } finally {
      await server.stop()
    }
  })

  it('shuts down gracefully, closing every client', async () => {
    const { server, port } = await startServer()
    const clients = await Promise.all([connectClient(port), connectClient(port)])
    await waitFor(() => server.clientCount === 2)

    const closes = clients.map(
      (client) => new Promise<void>((resolve) => client.socket.once('close', () => resolve())),
    )

    await server.stop()
    await Promise.all(closes)

    assert.equal(server.clientCount, 0)
    assert.equal(server.stats().listening, false)

    // The port must actually be free again.
    await assert.rejects(connectClient(port), /ECONNREFUSED/)
  })

  it('stopping twice is safe', async () => {
    const { server } = await startServer()
    await server.stop()
    await server.stop()
    assert.equal(server.stats().listening, false)
  })

  it('reports a listen failure instead of throwing asynchronously', async () => {
    const first = new NmeaTcpServer({ host: '127.0.0.1', port: 0 })
    await first.start()
    const port = first.address()?.port
    assert.ok(port)

    const second = new NmeaTcpServer({ host: '127.0.0.1', port })
    await assert.rejects(second.start(), /EADDRINUSE/)
    await first.stop()
  })
})
