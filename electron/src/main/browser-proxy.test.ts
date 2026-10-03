// @vitest-environment node
import { once } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserProxy } from './browser-proxy'

class EchoWebSocket extends EventTarget {
  readyState = 0
  protocol = 'agentsdock-port-tunnel-v1'
  binaryType = 'arraybuffer'
  bufferedAmount = 0
  constructor() {
    super()
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')) })
  }
  send(data: ArrayBuffer) { this.dispatchEvent(new MessageEvent('message', { data })) }
  close() {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code: 1000 }))
  }
}

const proxies: BrowserProxy[] = []
const sockets: Socket[] = []
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const proxy of proxies.splice(0)) proxy.dispose()
})

async function connectProxy() {
  const proxy = new BrowserProxy()
  proxies.push(proxy)
  const ports: number[] = []
  const config = await proxy.start('browser_test', port => {
    ports.push(port)
    return new EchoWebSocket() as unknown as WebSocket
  })
  const port = Number(new URL(config.proxyRules).port)
  const socket = createConnection(port, '127.0.0.1')
  sockets.push(socket)
  await once(socket, 'connect')
  return { socket, ports, config, proxy }
}

describe('BrowserProxy', () => {
  it.each([
    ['localhost', Buffer.concat([Buffer.from([3, 9]), Buffer.from('localhost')])],
    ['IPv4 loopback', Buffer.from([1, 127, 0, 0, 1])],
    ['IPv6 loopback', Buffer.from([4, ...Array(15).fill(0), 1])]
  ])('forwards %s, preserves raw bytes, and accepts a fragmented greeting', async (_label, address) => {
    const { socket, ports } = await connectProxy()
    socket.write(Buffer.from([5]))
    const greeting = once(socket, 'data')
    socket.write(Buffer.from([1, 0]))
    expect((await greeting)[0]).toEqual(Buffer.from([5, 0]))
    const connected = once(socket, 'data')
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([0, 80])]))
    expect((await connected)[0][1]).toBe(0)
    const echoed = once(socket, 'data')
    socket.write('HTTP, fetch and WebSocket payload')
    expect((await echoed)[0].toString()).toBe('HTTP, fetch and WebSocket payload')
    expect(ports).toEqual([80])
  })

  it('uses a fixed proxy to override Chromium loopback bypass', async () => {
    const { config } = await connectProxy()
    expect(config.mode).toBe('fixed_servers')
    expect(config.proxyBypassRules).toBe('<-loopback>')
  })

  it('keeps non-loopback traffic local instead of sending it to the server', async () => {
    const host = Object.values(networkInterfaces()).flat().find(address => address?.family === 'IPv4' && !address.internal)?.address
    if (!host) throw new Error('This network acceptance test needs a local IPv4 interface.')
    const server = createServer(socket => socket.pipe(socket))
    await new Promise<void>(resolve => server.listen(0, host, resolve))
    try {
      const port = (server.address() as { port: number }).port
      const { socket, ports } = await connectProxy()
      let response = once(socket, 'data')
      socket.write(Buffer.from([5, 1, 0]))
      await response
      response = once(socket, 'data')
      socket.write(Buffer.from([5, 1, 0, 1, ...host.split('.').map(Number), port >> 8, port & 255]))
      expect((await response)[0][1]).toBe(0)
      response = once(socket, 'data')
      socket.write('ordinary local network')
      expect((await response)[0].toString()).toBe('ordinary local network')
      expect(ports).toEqual([])
      socket.destroy()
    } finally { server.close() }
  })

  it('closes existing sockets on disposal', async () => {
    const { socket, proxy } = await connectProxy()
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    socket.on('error', error => expect((error as NodeJS.ErrnoException).code).toBe('ECONNRESET'))
    proxy.dispose()
    await closed
  })
})
