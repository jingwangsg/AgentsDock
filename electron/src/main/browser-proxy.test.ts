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

/** Answers a request with `size` bytes and then closes, as a server sending `Connection: close` does. */
class PageWebSocket extends EchoWebSocket {
  constructor(private readonly size: number) { super() }
  send() {
    for (let sent = 0; sent < this.size; sent += 64 * 1024) {
      this.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(64 * 1024) }))
    }
    // A real WebSocket fires close in a later task than the last message.
    setTimeout(() => this.close(), 0)
  }
}

/** The server could not connect to the host: it closes the tunnel with 4502 right after the tunnel opened. */
class UnreachableWebSocket extends EchoWebSocket {
  constructor() {
    super()
    queueMicrotask(() => {
      this.readyState = 3
      this.dispatchEvent(Object.assign(new Event('close'), { code: 4502 }))
    })
  }
}

const proxies: BrowserProxy[] = []
const sockets: Socket[] = []
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const proxy of proxies.splice(0)) proxy.dispose()
})

/** `allHosts`: whether the server takes a host for a browser tab's tunnel (browser_tunnel_hosts_v1). */
async function connectProxy(createRemote: (host?: string) => EventTarget = () => new EchoWebSocket(), allHosts = false) {
  const proxy = new BrowserProxy()
  proxies.push(proxy)
  const ports: number[] = []
  const hosts: Array<string | undefined> = []
  const config = await proxy.start('browser_test', (port, host) => {
    ports.push(port)
    hosts.push(host)
    return createRemote(host) as unknown as WebSocket
  }, allHosts)
  const port = Number(new URL(config.proxyRules).port)
  const connect = async () => {
    const socket = createConnection(port, '127.0.0.1')
    sockets.push(socket)
    await once(socket, 'connect')
    return socket
  }
  return { socket: await connect(), connect, ports, hosts, config, proxy }
}

/** The SOCKS5 greeting and a CONNECT to `host` by name; resolves with the proxy's reply code. */
async function socksConnect(socket: Socket, host: string, port: number): Promise<number> {
  let response = once(socket, 'data')
  socket.write(Buffer.from([5, 1, 0]))
  await response
  response = once(socket, 'data')
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), Buffer.from(host), Buffer.from([port >> 8, port & 255])]))
  return (await response)[0][1]
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

  it('sends a connection to another host through the server, with the host on its remote socket, when the server takes a host', async () => {
    const { socket, connect, ports, hosts } = await connectProxy(() => new EchoWebSocket(), true)
    expect(await socksConnect(socket, 'intranet.example', 443)).toBe(0)
    const echoed = once(socket, 'data')
    socket.write('TLS client hello')
    expect((await echoed)[0].toString()).toBe('TLS client hello')

    // An address literal, and bytes that arrive in one packet with the request.
    const second = await connect()
    let response = once(second, 'data')
    second.write(Buffer.from([5, 1, 0]))
    await response
    response = once(second, 'data')
    second.write(Buffer.concat([Buffer.from([5, 1, 0, 1, 10, 1, 2, 3, 0, 80]), Buffer.from('early bytes')]))
    const reply = (await response)[0]
    expect(reply[1]).toBe(0)
    const early = reply.length > 10 ? reply.subarray(10) : (await once(second, 'data'))[0]
    expect(early.toString()).toBe('early bytes')

    // The tab's localhost is still the server's loopback: no host on that remote socket.
    const third = await connect()
    expect(await socksConnect(third, 'localhost', 8080)).toBe(0)
    const loopbackEcho = once(third, 'data')
    third.write('to the loopback')
    expect((await loopbackEcho)[0].toString()).toBe('to the loopback')
    expect([ports, hosts]).toEqual([[443, 80, 8080], ['intranet.example', '10.1.2.3', undefined]])
  })

  it('takes connections to more ports of other hosts than the 16 tunnels a tab may have', async () => {
    const { socket, connect, ports } = await connectProxy(() => new EchoWebSocket(), true)
    for (let port = 8001; port <= 8017; port += 1) {
      const next = port === 8001 ? socket : await connect()
      expect(await socksConnect(next, 'intranet.example', port)).toBe(0)
      const echoed = once(next, 'data')
      next.write(`to port ${port}`)
      expect((await echoed)[0].toString()).toBe(`to port ${port}`)
    }
    expect(ports).toEqual(Array.from({ length: 17 }, (_, index) => 8001 + index))
  })

  it('ends only the connection whose host the server could not reach', async () => {
    const { socket, connect } = await connectProxy(host => host === 'down.example' ? new UnreachableWebSocket() : new EchoWebSocket(), true)
    expect(await socksConnect(socket, 'up.example', 443)).toBe(0)
    const down = await connect()
    const closed = once(down, 'close')
    expect(await socksConnect(down, 'down.example', 443)).toBe(0)
    await closed
    const echoed = once(socket, 'data')
    socket.write('still open')
    expect((await echoed)[0].toString()).toBe('still open')
  })

  it('dials another host from this Mac when the server takes no host for a tab\'s tunnel', async () => {
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

  it('delivers the whole response to a slow reader when the remote closes right after the last byte', async () => {
    // Larger than the 4 MB the tunnel used to hold for a slow reader.
    const size = 8 * 1024 * 1024
    const { socket } = await connectProxy(() => new PageWebSocket(size))
    let response = once(socket, 'data')
    socket.write(Buffer.from([5, 1, 0]))
    await response
    response = once(socket, 'data')
    socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]))
    expect((await response)[0][1]).toBe(0)

    socket.pause()
    socket.write('GET / HTTP/1.0\r\n\r\n')
    // Let the whole response and the close reach the tunnel before the reader takes anything.
    await new Promise(resolve => setTimeout(resolve, 200))
    let received = 0
    socket.on('data', data => { received += data.length })
    const ended = once(socket, 'end')
    socket.resume()
    await ended
    expect(received).toBe(size)
  })

  it('closes existing sockets on disposal', async () => {
    const { socket, proxy } = await connectProxy()
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    socket.on('error', error => expect((error as NodeJS.ErrnoException).code).toBe('ECONNRESET'))
    proxy.dispose()
    await closed
  })
})
