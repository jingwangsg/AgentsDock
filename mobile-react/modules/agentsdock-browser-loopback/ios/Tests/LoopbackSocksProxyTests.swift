// macOS test program for LoopbackSocksProxy.swift and WebViewProfileStore.swift; run with
// `pnpm run test:browser-loopback-ios`. A fake tunnel server (raw TCP, minimal RFC 6455) checks
// what the proxy sends and plays the server's side.
import CryptoKit
import Foundation
import Network

private var failures = 0
private func check(_ condition: Bool, _ message: String, line: Int = #line) {
  if !condition { failures += 1; print("  FAIL line \(line): \(message)") }
}

/// A blocking TCP socket with a 5 s receive timeout.
private final class Socket {
  let fd: Int32
  private(set) var peerClosed = false
  init(fd: Int32) {
    self.fd = fd
    var timeout = timeval(tv_sec: 5, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
  }
  static func connect(_ port: UInt16) -> Socket {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    var address = loopback(port)
    let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    precondition(result == 0, "connect to \(port) failed")
    return Socket(fd: fd)
  }
  func write(_ bytes: [UInt8]) { _ = bytes.withUnsafeBytes { send(fd, $0.baseAddress, $0.count, 0) } }
  /// Exactly `count` bytes, or fewer when the peer closed or 5 s passed.
  func read(_ count: Int) -> [UInt8] {
    var out: [UInt8] = []
    var buffer = [UInt8](repeating: 0, count: max(count, 1))
    while out.count < count {
      let n = recv(fd, &buffer, count - out.count, 0)
      if n == 0 { peerClosed = true }
      if n <= 0 { break }
      out += buffer[0..<n]
    }
    return out
  }
  /// Everything until the peer closes (or 5 s of silence).
  func readToEnd() -> [UInt8] {
    var out: [UInt8] = []
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
      let n = recv(fd, &buffer, buffer.count, 0)
      if n == 0 { peerClosed = true }
      if n <= 0 { return out }
      out += buffer[0..<n]
    }
  }
  func readHead() -> String {
    var head: [UInt8] = []
    while !head.suffix(4).elementsEqual([13, 10, 13, 10]) {
      let byte = read(1)
      if byte.isEmpty { break }
      head += byte
    }
    return String(decoding: head, as: UTF8.self)
  }
  func close() { Darwin.close(fd) }
}

private func loopback(_ port: UInt16) -> sockaddr_in {
  var address = sockaddr_in()
  address.sin_family = sa_family_t(AF_INET)
  address.sin_port = port.bigEndian
  address.sin_addr.s_addr = inet_addr("127.0.0.1")
  return address
}

/// The server end of one tunnel WebSocket.
private final class FakeTunnel {
  let socket: Socket
  let head: String
  init(socket: Socket, head: String) { self.socket = socket; self.head = head }

  var requestLine: String { String(head.split(separator: "\r\n").first ?? "") }
  func headers(_ name: String) -> [String] {
    head.split(separator: "\r\n").dropFirst().compactMap { line in
      let parts = line.split(separator: ":", maxSplits: 1)
      guard parts.count == 2, parts[0].lowercased() == name.lowercased() else { return nil }
      return parts[1].trimmingCharacters(in: .whitespaces)
    }
  }
  var protocols: [String] { headers("Sec-WebSocket-Protocol").flatMap { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } } }

  func accept(protocol chosen: String?) {
    let key = headers("Sec-WebSocket-Key").first ?? ""
    let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
    var response = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n"
    if let chosen { response += "Sec-WebSocket-Protocol: \(chosen)\r\n" }
    socket.write(Array((response + "\r\n").utf8))
  }

  func send(opcode: UInt8, _ payload: [UInt8]) {
    var frame: [UInt8] = [0x80 | opcode]
    if payload.count < 126 {
      frame.append(UInt8(payload.count))
    } else if payload.count < 65536 {
      frame += [126, UInt8(payload.count >> 8), UInt8(payload.count & 0xFF)]
    } else {
      frame.append(127)
      frame += (0..<8).reversed().map { UInt8((payload.count >> ($0 * 8)) & 0xFF) }
    }
    socket.write(frame + payload)
  }

  /// The next client frame, unmasked; nil when the connection ended first.
  func receive() -> (opcode: UInt8, payload: [UInt8])? {
    let header = socket.read(2)
    guard header.count == 2 else { return nil }
    var length = Int(header[1] & 0x7F)
    if length == 126 { length = socket.read(2).reduce(0) { $0 << 8 | Int($1) } }
    if length == 127 { length = socket.read(8).reduce(0) { $0 << 8 | Int($1) } }
    let mask = socket.read(4)
    let payload = socket.read(length)
    guard mask.count == 4, payload.count == length else { return nil }
    return (header[0] & 0x0F, payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })
  }

  /// How the tunnel ended, skipping data frames: "close <code>", "eof", or "open" after 5 s.
  /// URLSessionWebSocketTask.cancel(with:reason:) sometimes ends the connection before its close
  /// frame is written (measured on macOS 26.7), so a caller accepts "eof" as well.
  func receiveEnd() -> String {
    while let frame = receive() {
      if frame.opcode == 8 { return "close \(frame.payload.count >= 2 ? Int(frame.payload[0]) << 8 | Int(frame.payload[1]) : 1005)" }
    }
    return socket.peerClosed ? "eof" : "open"
  }
}

private final class FakeServer {
  let fd: Int32
  let port: UInt16
  init() {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    self.fd = fd
    var address = loopback(0)
    _ = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    listen(fd, 16)
    var bound = sockaddr_in()
    var size = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &bound) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &size) } }
    port = UInt16(bigEndian: bound.sin_port)
  }
  var prefix: String { "ws://127.0.0.1:\(port)/api/sessions/browser_t/ports/" }
  /// The next tunnel request, or nil when none arrives within `seconds`.
  func next(within seconds: Int32 = 5) -> FakeTunnel? {
    var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    guard poll(&poller, 1, seconds * 1000) == 1 else { return nil }
    let socket = Socket(fd: Darwin.accept(fd, nil, nil))
    return FakeTunnel(socket: socket, head: socket.readHead())
  }
}

private func startProxy(_ server: FakeServer, allHosts: Bool, token: String = "s3cret?>") -> (LoopbackSocksProxy, UInt16) {
  let proxy = LoopbackSocksProxy()
  proxy.queue.sync { proxy.route = TunnelRoute(tunnelPrefix: server.prefix, token: token, allHosts: allHosts) }
  let ready = DispatchSemaphore(value: 0)
  var port: UInt16?
  proxy.start(port: 0) { port = $0; ready.signal() }
  ready.wait()
  return (proxy, port!)
}

/// AgentsDockBrowserLoopbackModule.listen's binding: the previous port, or any port when that one
/// cannot be bound.
private func listenLikeModule(_ proxy: LoopbackSocksProxy, previous: UInt16, done: @escaping (UInt16?) -> Void) {
  proxy.start(port: previous) { port in
    if port == nil, previous != 0 { proxy.start(port: 0, ready: done) } else { done(port) }
  }
}

/// Whether something accepts TCP connections on 127.0.0.1:`port`.
private func accepts(_ port: UInt16) -> Bool {
  let fd = socket(AF_INET, SOCK_STREAM, 0)
  defer { Darwin.close(fd) }
  var address = loopback(port)
  return withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } } == 0
}

/// Sends a no-authentication greeting and a CONNECT host:port at once; the proxy answers both with
/// `granted` or `refused`.
private func requestConnect(_ client: Socket, host: String, port: UInt16) {
  let name = Array(host.utf8)
  client.write([5, 1, 0] + [5, 1, 0, 3, UInt8(name.count)] + name + [UInt8(port >> 8), UInt8(port & 0xFF)])
}

private let granted: [UInt8] = [5, 0] + [5, 0, 0, 1, 0, 0, 0, 0, 0, 0]
private let refused: [UInt8] = [5, 0] + [5, 2, 0, 1, 0, 0, 0, 0, 0, 0]

private func run(_ name: String, _ body: (FakeServer) -> Void) {
  let before = failures
  body(FakeServer())
  print(failures == before ? "ok   \(name)" : "FAIL \(name)")
}

@main
struct LoopbackSocksProxyTests {
  static func main() {
    setvbuf(stdout, nil, _IOLBF, 0)
    run("a greeting without the no-authentication method is answered 05 FF") { server in
      let (proxy, port) = startProxy(server, allHosts: true)
      let client = Socket.connect(port)
      client.write([5, 1, 2])
      check(client.read(2) == [5, 0xFF], "method reply")
      check(client.readToEnd().isEmpty, "connection ends")
      proxy.close()
    }

    run("a command other than CONNECT ends the connection without a tunnel") { server in
      let (proxy, port) = startProxy(server, allHosts: true)
      let client = Socket.connect(port)
      client.write([5, 1, 0])
      check(client.read(2) == [5, 0], "method reply")
      client.write([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]) // BIND
      check(client.readToEnd().isEmpty, "no reply, connection ends")
      check(server.next(within: 1) == nil, "no tunnel requested")
      proxy.close()
    }

    run("CONNECT localhost carries bytes over the port's tunnel with the token protocol only") { server in
      let (proxy, port) = startProxy(server, allHosts: true)
      let client = Socket.connect(port)
      requestConnect(client, host: "localhost", port: 8265)
      guard let tunnel = server.next() else { check(false, "no tunnel request"); return }
      check(tunnel.requestLine == "GET /api/sessions/browser_t/ports/8265/tunnel/ws HTTP/1.1", "request line: \(tunnel.requestLine)")
      // base64url("s3cret?>") is "czNjcmV0Pz4=": '/' and '+' never appear and the padding is dropped.
      check(tunnel.protocols == ["agentsdock-port-tunnel-v1", "agentsdock-token.czNjcmV0Pz4"], "protocols: \(tunnel.protocols)")
      check(tunnel.headers("Sec-WebSocket-Protocol").count == 1, "one protocol header")
      for forbidden in ["Cookie", "Authorization", "X-ZenithDock-Token", "X-AgentsDock-Token"] {
        check(tunnel.headers(forbidden).isEmpty, "no \(forbidden) header")
      }
      tunnel.accept(protocol: "agentsdock-port-tunnel-v1")
      check(client.read(12) == granted, "granted")
      client.write(Array("GET / HTTP/1.1\r\n\r\n".utf8))
      let frame = tunnel.receive()
      check(frame?.opcode == 2 && frame?.payload == Array("GET / HTTP/1.1\r\n\r\n".utf8), "client bytes in a binary frame")
      tunnel.send(opcode: 2, Array("HTTP/1.1 200 OK\r\n".utf8))
      check(client.read(17) == Array("HTTP/1.1 200 OK\r\n".utf8), "server bytes reach the client")
      client.close()
      let end = tunnel.receiveEnd()
      check(["close 1000", "eof"].contains(end), "local EOF ends the tunnel: \(end)")
      proxy.close()
    }

    run("a named host is sent to the server with ?host= when the route allows every host") { server in
      let (proxy, port) = startProxy(server, allHosts: true)
      let client = Socket.connect(port)
      requestConnect(client, host: "example.test", port: 443)
      let tunnel = server.next()
      check(tunnel?.requestLine == "GET /api/sessions/browser_t/ports/443/tunnel/ws?host=example.test HTTP/1.1", "request line: \(tunnel?.requestLine ?? "none")")
      tunnel?.accept(protocol: "agentsdock-port-tunnel-v1")
      client.close()
      proxy.close()
    }

    run("a named host is refused, without a tunnel, when the route carries loopback only") { server in
      let (proxy, port) = startProxy(server, allHosts: false)
      let client = Socket.connect(port)
      requestConnect(client, host: "example.test", port: 443)
      check(client.read(12) == refused, "refused")
      check(server.next(within: 1) == nil, "no tunnel requested")
      check(client.readToEnd().isEmpty, "connection ends")
      proxy.close()
    }

    run("a server that does not answer with the tunnel protocol is refused") { server in
      let (proxy, port) = startProxy(server, allHosts: true)
      let client = Socket.connect(port)
      requestConnect(client, host: "localhost", port: 8265)
      let tunnel = server.next()
      tunnel?.accept(protocol: nil)
      check(client.read(12) == refused, "refused")
      tunnel?.socket.close()
      proxy.close()
    }

    run("stop() ends an open tunnel and the listener; start() rebinds the same port") { server in
      let (proxy, port) = startProxy(server, allHosts: true)
      let client = Socket.connect(port)
      requestConnect(client, host: "localhost", port: 8265)
      guard let tunnel = server.next() else { check(false, "no tunnel request"); return }
      tunnel.accept(protocol: "agentsdock-port-tunnel-v1")
      check(client.read(12) == granted, "granted")
      proxy.stop()
      let end = tunnel.receiveEnd()
      check(["close 1000", "eof"].contains(end), "the server's tunnel ends: \(end)")
      check(client.readToEnd().isEmpty, "local connection ends")
      let refusedFd = socket(AF_INET, SOCK_STREAM, 0)
      var address = loopback(port)
      let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(refusedFd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
      check(result != 0, "listener closed")
      Darwin.close(refusedFd)
      let ready = DispatchSemaphore(value: 0)
      var again: UInt16?
      proxy.start(port: port) { again = $0; ready.signal() }
      ready.wait()
      check(again == port, "rebound \(String(describing: again)) on \(port)")
      proxy.close()
    }

    run("stop() during a bind binds nothing; the next start() answers the waiting caller") { server in
      let (first, previous) = startProxy(server, allHosts: true)
      first.close()
      let proxy = LoopbackSocksProxy()
      let answered = DispatchSemaphore(value: 0)
      var ports: [UInt16?] = []
      listenLikeModule(proxy, previous: previous) { ports.append($0); answered.signal() }
      proxy.stop() // the app went to the background before the listener was ready
      check(answered.wait(timeout: .now() + 1) == .timedOut, "answered after stop(): \(ports)")
      check(!accepts(previous), "no listener on \(previous)")
      proxy.start(port: previous) { _ in } // the app came back
      check(answered.wait(timeout: .now() + 5) == .success && ports == [previous], "answered with \(ports), not [\(previous)]")
      proxy.close()
    }

    run("close() during a bind answers nil and binds nothing") { server in
      let (first, previous) = startProxy(server, allHosts: true)
      first.close()
      let proxy = LoopbackSocksProxy()
      let answered = DispatchSemaphore(value: 0)
      var ports: [UInt16?] = []
      listenLikeModule(proxy, previous: previous) { ports.append($0); answered.signal() }
      proxy.close() // the tab was released or re-routed before the listener was ready
      check(answered.wait(timeout: .now() + 5) == .success && ports == [nil], "answered with \(ports)")
      Thread.sleep(forTimeInterval: 0.3)
      check(!accepts(previous), "no listener on \(previous)")
      var late: UInt16? = 1
      let done = DispatchSemaphore(value: 0)
      proxy.start(port: 0) { late = $0; done.signal() }
      done.wait()
      check(late == nil, "a closed proxy started again on \(String(describing: late))")
    }

    run("everything the server sends before it closes reaches the client") { server in
      let (proxy, port) = startProxy(server, allHosts: true)
      let client = Socket.connect(port)
      requestConnect(client, host: "localhost", port: 8265)
      guard let tunnel = server.next() else { check(false, "no tunnel request"); return }
      tunnel.accept(protocol: "agentsdock-port-tunnel-v1")
      check(client.read(12) == granted, "granted")
      let sent = (0..<40).flatMap { [UInt8](repeating: UInt8($0), count: 64 * 1024) }
      // The proxy forwards one frame at a time, so the server's writes wait for the client's reads.
      DispatchQueue.global().async {
        for start in stride(from: 0, to: sent.count, by: 64 * 1024) { tunnel.send(opcode: 2, Array(sent[start..<start + 64 * 1024])) }
        tunnel.send(opcode: 8, [0x03, 0xE8])
        tunnel.socket.close()
      }
      let received = client.readToEnd()
      check(received.count == sent.count && received == sent, "received \(received.count) of \(sent.count) bytes")
      proxy.close()
    }

    run("a text frame closes the tunnel 1003 and ends the local connection") { server in
      let (proxy, port) = startProxy(server, allHosts: true)
      let client = Socket.connect(port)
      requestConnect(client, host: "localhost", port: 8265)
      guard let tunnel = server.next() else { check(false, "no tunnel request"); return }
      tunnel.accept(protocol: "agentsdock-port-tunnel-v1")
      check(client.read(12) == granted, "granted")
      tunnel.send(opcode: 1, Array("text".utf8))
      let end = tunnel.receiveEnd()
      check(["close 1003", "eof"].contains(end), "the tunnel ends: \(end)")
      check(client.readToEnd().isEmpty, "local connection ends")
      proxy.close()
    }

    run("loopback hosts are recognized without resolving names") { _ in
      for host in ["localhost", "LOCALHOST.", "a.localhost", "127.1.2.3", "::1", "[::1]"] {
        check(isLoopback(host), "\(host) is loopback")
      }
      for host in ["128.0.0.1", "localhost.example", "example.com", "127.1", "::2"] {
        check(!isLoopback(host), "\(host) is not loopback")
      }
    }

    run("a web view profile names the same data store as the patched react-native-webview") { _ in
      let id = profileStoreIdentifier("agentsdock-browser-default-browser_1a2b3c").uuidString
      check(id == "C82A50EC-B270-8AAE-B642-7E9F0C459051", id)
    }

    print(failures == 0 ? "all passed" : "\(failures) failed")
    exit(failures == 0 ? 0 : 1)
  }
}
