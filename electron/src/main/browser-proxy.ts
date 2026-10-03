import { createConnection, createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { isLoopbackHostname } from '../shared/team-hub-url'
import { PortTunnelManager } from './port-tunnel-manager'

/** Keeps page origins intact while sending loopback TCP through the authenticated server. */
export class BrowserProxy {
  private readonly tunnels = new PortTunnelManager(1)
  private readonly sockets = new Set<Socket>()
  private server: Server | null = null
  private disposed = false

  async start(surfaceId: string, remoteSocket: (port: number) => WebSocket): Promise<{
    mode: 'fixed_servers'; proxyRules: string; proxyBypassRules: string
  }> {
    const server = createServer(socket => this.accept(socket, surfaceId, remoteSocket))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    if (this.disposed) {
      server.close()
      throw new Error('Browser connection was closed.')
    }
    const port = (server.address() as AddressInfo).port

    return {
      mode: 'fixed_servers',
      proxyRules: `socks5://127.0.0.1:${port}`,
      // PAC cannot override Chromium's implicit loopback bypass; this needs a fixed proxy.
      proxyBypassRules: '<-loopback>'
    }
  }

  dispose(): void {
    this.disposed = true
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.tunnels.disposeAll()
    if (this.server?.listening) this.server.close()
  }

  private accept(socket: Socket, surfaceId: string, remoteSocket: (port: number) => WebSocket): void {
    if (this.disposed || this.sockets.size >= 64) { socket.destroy(); return }
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(10_000, () => socket.destroy())
    let greeting = true
    let bytes = Buffer.alloc(0)
    const receive = (chunk: Buffer): void => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > 512) { socket.destroy(); return }
      if (greeting) {
        if (bytes.length < 2 || bytes.length < 2 + bytes[1]) return
        if (bytes[0] !== 5 || !bytes.subarray(2, 2 + bytes[1]).includes(0)) {
          socket.end(Buffer.from([5, 255])); return
        }
        bytes = bytes.subarray(2 + bytes[1])
        socket.write(Buffer.from([5, 0]))
        greeting = false
      }
      if (bytes.length < 5) return
      const type = bytes[3]
      const addressSize = type === 1 ? 4 : type === 4 ? 16 : type === 3 ? 1 + bytes[4] : 0
      if (bytes[0] !== 5 || bytes[1] !== 1 || bytes[2] !== 0 || !addressSize) {
        socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return
      }
      const size = 4 + addressSize + 2
      if (bytes.length < size) return
      const address = bytes.subarray(4, 4 + addressSize)
      const host = type === 3 ? address.subarray(1).toString('utf8')
        : type === 1 ? [...address].join('.')
          : address.subarray(0, 15).every(byte => byte === 0) && address[15] === 1 ? '::1'
            : Array.from({ length: 8 }, (_, index) => address.readUInt16BE(index * 2).toString(16)).join(':')
      const port = bytes.readUInt16BE(size - 2)
      if (port === 0) {
        socket.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])); return
      }
      socket.pause()
      socket.removeListener('data', receive)
      const pending = bytes.subarray(size)
      const loopback = isLoopbackHostname(host.replace(/\.$/, '')) || host.toLowerCase().endsWith('.localhost')
      const destination = loopback
        ? this.tunnels.start(surfaceId, port, undefined, () => remoteSocket(port)).then(forward => ({ port: forward.localPort, host: '127.0.0.1' }))
        : Promise.resolve({ port, host })
      void destination.then(target => {
        if (this.disposed || socket.destroyed) return
        const upstream = createConnection(target)
        upstream.on('error', () => socket.destroy())
        upstream.once('close', () => socket.destroy())
        socket.once('close', () => upstream.destroy())
        upstream.once('connect', () => {
          socket.setTimeout(0)
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          if (pending.length) upstream.write(pending)
          socket.pipe(upstream).pipe(socket)
          socket.resume()
        })
      }).catch(() => socket.destroy())
    }
    socket.on('data', receive)
  }
}
