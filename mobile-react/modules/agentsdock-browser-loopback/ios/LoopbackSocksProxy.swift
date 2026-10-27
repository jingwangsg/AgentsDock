import Foundation
import Network

private let tunnelProtocol = "agentsdock-port-tunnel-v1"
private let tokenProtocolPrefix = "agentsdock-token."
private let handshakeTimeout: TimeInterval = 10
private let tunnelOpenTimeout: TimeInterval = 15
private let readChunkBytes = 64 * 1024

/// Where connections go: one browser tab's port tunnel on the selected server. `allHosts`
/// when that server dials a named host; otherwise only loopback destinations are carried.
struct TunnelRoute {
  let tunnelPrefix: String
  let token: String
  let allHosts: Bool
}

/// A SOCKS5 listener on 127.0.0.1 that carries each CONNECT over the server's port tunnel:
/// one WebSocket per TCP connection, raw bytes both ways, the destination port kept. A loopback
/// destination is the server's own localhost; any other host is named to the server (`?host=`)
/// when the route allows that. Nothing is dialed from the phone; an excluded destination is refused.
/// The Android module's LoopbackSocksProxy.kt speaks the same protocol. Everything runs on `queue`.
final class LoopbackSocksProxy: NSObject, URLSessionWebSocketDelegate {
  let queue = DispatchQueue(label: "agentsdock.browser-loopback")
  var route: TunnelRoute?
  private var listener: NWListener?
  private var waiting: [(UInt16?) -> Void] = [] // start() callers while the listener binds
  private var closed = false
  private var bridges: [Int: TunnelBridge] = [:] // by URLSessionTask.taskIdentifier
  private var pending: [ObjectIdentifier: NWConnection] = [:] // accepted, CONNECT not read yet
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    // load-bearing: the server refuses a tunnel that carries a Cookie or Authorization header (4401).
    config.httpShouldSetCookies = false
    config.httpCookieStorage = nil
    config.urlCredentialStorage = nil
    let delegateQueue = OperationQueue()
    delegateQueue.underlyingQueue = queue
    delegateQueue.maxConcurrentOperationCount = 1
    return URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
  }()

  /// Listens on 127.0.0.1:`port` (0 = any) unless already listening; `ready` gets the bound port,
  /// or nil when binding failed or close() came first. A stop() before the bind finishes leaves the
  /// caller waiting for the next start(): nil would read as a failed bind, and a caller retrying on
  /// another port would then listen while the app is in the background.
  func start(port: UInt16, ready: @escaping (UInt16?) -> Void) {
    queue.async { [self] in
      if closed { ready(nil); return }
      if let listener, listener.state == .ready { ready(listener.port?.rawValue); return }
      waiting.append(ready)
      if listener != nil { return }
      let parameters = NWParameters.tcp
      parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
      // Rebinding the port this listener had needs it while that port's closed connections wait out
      // TIME_WAIT. A port another live listener holds still fails (EADDRINUSE, measured).
      parameters.allowLocalEndpointReuse = true
      guard let next = try? NWListener(using: parameters) else { report(nil); return }
      listener = next
      next.stateUpdateHandler = { [weak self] state in
        guard let self, self.listener === next else { return }
        switch state {
        case .ready:
          self.report(next.port?.rawValue)
        case .failed:
          next.cancel()
          self.listener = nil
          self.report(nil)
        default: break
        }
      }
      next.newConnectionHandler = { [weak self] client in self?.accept(client) }
      next.start(queue: queue)
    }
  }

  /// Stops listening and ends every open connection and its tunnel.
  func stop() {
    queue.async { [self] in
      listener?.cancel()
      listener = nil
      for client in pending.values { client.cancel() }
      pending.removeAll()
      // A destination such as Ray's dashboard never ends an idle tunnel itself, and the server
      // counts each open tunnel against the tab's limit.
      for bridge in bridges.values { bridge.finish() }
      bridges.removeAll()
    }
  }

  /// stop() for good: the URLSession holds this proxy as its delegate until it is invalidated.
  func close() {
    stop()
    queue.async { [self] in
      closed = true
      report(nil)
      session.invalidateAndCancel()
    }
  }

  private func report(_ port: UInt16?) {
    let callers = waiting
    waiting = []
    for ready in callers { ready(port) }
  }

  private func accept(_ client: NWConnection) {
    pending[ObjectIdentifier(client)] = client
    client.start(queue: queue)
    let deadline = DispatchWorkItem { [weak self] in
      self?.pending.removeValue(forKey: ObjectIdentifier(client))
      client.cancel()
    }
    queue.asyncAfter(deadline: .now() + handshakeTimeout, execute: deadline)
    readConnectRequest(client) { [weak self] request in
      deadline.cancel()
      guard let self, self.pending.removeValue(forKey: ObjectIdentifier(client)) != nil else { return }
      guard let request else { client.cancel(); return }
      self.open(client, request)
    }
  }

  private func open(_ client: NWConnection, _ request: ConnectRequest) {
    guard let route, route.allHosts || isLoopback(request.host) else {
      request.reply(client, granted: false); return
    }
    let hostQuery = isLoopback(request.host) ? "" : "?host=\(request.host.addingPercentEncoding(withAllowedCharacters: queryValueAllowed)!)"
    guard let url = URL(string: "\(route.tunnelPrefix)\(request.port)/tunnel/ws\(hostQuery)") else {
      request.reply(client, granted: false); return
    }
    let token = Data(route.token.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .trimmingCharacters(in: CharacterSet(charactersIn: "="))
    let task = session.webSocketTask(with: url, protocols: [tunnelProtocol, tokenProtocolPrefix + token])
    let bridge = TunnelBridge(client: client, task: task, request: request) { [weak self] in
      self?.bridges.removeValue(forKey: task.taskIdentifier)
    }
    bridges[task.taskIdentifier] = bridge
    queue.asyncAfter(deadline: .now() + tunnelOpenTimeout) { [weak bridge] in bridge?.openTimedOut() }
    task.resume()
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol negotiated: String?) {
    bridges[webSocketTask.taskIdentifier]?.opened(accepted: negotiated == tunnelProtocol)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    bridges[webSocketTask.taskIdentifier]?.finish()
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    bridges[task.taskIdentifier]?.finish()
  }
}

/// One local connection and its tunnel. Each direction moves one chunk at a time, so a slow
/// side holds the other back instead of buffering without limit.
private final class TunnelBridge {
  private let client: NWConnection
  private let task: URLSessionWebSocketTask
  private let request: ConnectRequest
  private let onFinish: () -> Void
  private var state = State.opening
  private enum State { case opening, open, finished }

  init(client: NWConnection, task: URLSessionWebSocketTask, request: ConnectRequest, onFinish: @escaping () -> Void) {
    self.client = client
    self.task = task
    self.request = request
    self.onFinish = onFinish
  }

  func opened(accepted: Bool) {
    guard state == .opening else { return }
    guard accepted else { finish(); return }
    state = .open
    request.reply(client, granted: true)
    pumpToServer()
    pumpToClient()
  }

  func openTimedOut() {
    if state == .opening { finish() }
  }

  func finish() {
    guard state != .finished else { return }
    let wasOpening = state == .opening
    state = .finished
    task.cancel(with: .normalClosure, reason: "Local connection closed".data(using: .utf8))
    // A refused CONNECT gets its reply before the connection ends.
    if wasOpening { request.reply(client, granted: false) } else { client.cancel() }
    onFinish()
  }

  private func pumpToServer() {
    client.receive(minimumIncompleteLength: 1, maximumLength: readChunkBytes) { [self] data, _, isComplete, error in
      guard state == .open else { return }
      guard let data, !data.isEmpty else { if isComplete || error != nil { finish() } else { pumpToServer() }; return }
      task.send(.data(data)) { [self] error in
        if error != nil || isComplete { finish() } else { pumpToServer() }
      }
    }
  }

  private func pumpToClient() {
    task.receive { [self] result in
      guard state == .open else { return }
      switch result {
      case .success(.data(let data)):
        client.send(content: data, completion: .contentProcessed { [self] error in
          if error != nil { finish() } else { pumpToClient() }
        })
      case .success:
        // The tunnel carries binary frames only.
        task.cancel(with: .unsupportedData, reason: nil)
        finish()
      case .failure:
        finish()
      }
    }
  }
}

struct ConnectRequest {
  let host: String
  let port: UInt16

  func reply(_ client: NWConnection, granted: Bool) {
    // SOCKS5 failure 0x02: connection not allowed by ruleset.
    client.send(content: Data([5, granted ? 0 : 2, 0, 1, 0, 0, 0, 0, 0, 0]), completion: .contentProcessed { _ in
      if !granted { client.cancel() }
    })
  }
}

/// Reads a SOCKS5 (no authentication) CONNECT; nil for anything else. WebKit's proxy client speaks
/// SOCKS5 only, so unlike the Android listener this one has no SOCKS4.
func readConnectRequest(_ client: NWConnection, _ done: @escaping (ConnectRequest?) -> Void) {
  func read(_ count: Int, _ next: @escaping ([UInt8]) -> Void) {
    client.receive(minimumIncompleteLength: count, maximumLength: count) { data, _, _, _ in
      guard let data, data.count == count else { done(nil); return }
      next([UInt8](data))
    }
  }
  read(2) { head in
    guard head[0] == 5 else { done(nil); return }
    read(Int(head[1])) { methods in
      guard methods.contains(0) else {
        client.send(content: Data([5, 0xFF]), completion: .contentProcessed { _ in done(nil) }); return
      }
      client.send(content: Data([5, 0]), completion: .idempotent)
      read(4) { header in
        guard header[0] == 5, header[1] == 1 else { done(nil); return }
        func finish(_ host: String) { read(2) { port in done(ConnectRequest(host: host, port: UInt16(port[0]) << 8 | UInt16(port[1]))) } }
        switch header[3] {
        case 1: read(4) { finish(IPv4Address(Data($0))!.debugDescription) }
        case 3: read(1) { length in read(Int(length[0])) { finish(String(decoding: $0, as: UTF8.self)) } }
        case 4: read(16) { finish(IPv6Address(Data($0))!.debugDescription) }
        default: done(nil)
        }
      }
    }
  }
}

// RFC 3986 unreserved characters; ASCII only (CharacterSet.alphanumerics includes non-ASCII letters).
private let queryValueAllowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

/// localhost names and loopback literals only; a name is never resolved here.
func isLoopback(_ host: String) -> Bool {
  var name = host.lowercased()
  while name.hasSuffix(".") { name.removeLast() }
  if name.hasPrefix("["), name.hasSuffix("]") { name = String(name.dropFirst().dropLast()) }
  if name == "localhost" || name.hasSuffix(".localhost") { return true }
  // 127.0.0.0/8, as Java's isLoopbackAddress on Android; IPv4Address.isLoopback is 127.0.0.1 only.
  if let v4 = IPv4Address(name), name.split(separator: ".").count == 4 { return v4.rawValue.first == 127 }
  if name.contains(":"), let v6 = IPv6Address(name) { return v6.isLoopback }
  return false
}
