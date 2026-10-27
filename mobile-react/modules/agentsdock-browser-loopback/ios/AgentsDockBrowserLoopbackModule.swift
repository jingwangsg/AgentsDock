import ExpoModulesCore
import Network
import WebKit

/// Sends a browser tab's web view requests to its own [LoopbackSocksProxy], so the tab's pages load
/// through the selected server's network: its localhost as on the desktop, and every other host too
/// when that server dials a named host (`allHosts`). Hosts the caller names stay direct. The proxy is
/// set on the tab's own WKWebsiteDataStore (iOS 17), so each tab has its own route, unlike Android's
/// one app-wide override; release ends only that tab's.
public final class AgentsDockBrowserLoopbackModule: Module {
  private final class Route {
    let proxy = LoopbackSocksProxy()
    let store: WKWebsiteDataStore // held so the proxy setting outlives a store no web view holds yet
    let directHosts: [String]
    let allHosts: Bool
    var appliedPort: UInt16?
    init(store: WKWebsiteDataStore, directHosts: [String], allHosts: Bool) {
      self.store = store
      self.directHosts = directHosts
      self.allHosts = allHosts
    }
  }

  // Main queue only.
  private var routes: [String: Route] = [:]
  // A profile's last port, reused after release, background, or a reload: a live store then keeps an
  // unchanged proxy setting (WebKit bug 316948: a changed setting can miss pooled connections).
  private var ports: [String: UInt16] = [:]

  public func definition() -> ModuleDefinition {
    Name("AgentsDockBrowserLoopback")

    // On the main queue, so route and release apply in call order.
    AsyncFunction("routeAsync") { (profile: String, tunnelPrefix: String, token: String, directHosts: [String], allHosts: Bool, promise: Promise) in
      guard #available(iOS 17.0, *) else { promise.resolve(false); return }
      routes[profile]?.proxy.close()
      let route = Route(store: WKWebsiteDataStore(forIdentifier: profileStoreIdentifier(profile)), directHosts: directHosts, allHosts: allHosts)
      routes[profile] = route
      route.proxy.queue.sync { route.proxy.route = TunnelRoute(tunnelPrefix: tunnelPrefix, token: token, allHosts: allHosts) }
      listen(profile, route) { routed in promise.resolve(routed) }
    }.runOnQueue(.main)

    AsyncFunction("releaseAsync") { (profile: String) in
      // The store keeps its proxy setting: a load after release fails instead of leaving from the phone.
      routes.removeValue(forKey: profile)?.proxy.close()
    }.runOnQueue(.main)

    // TN2277: a suspended app cannot serve its listening socket, and the system may reclaim it.
    OnAppEntersBackground {
      for route in routes.values { route.proxy.stop() }
    }

    OnAppEntersForeground {
      for (profile, route) in routes { listen(profile, route) { _ in } }
    }

    OnDestroy {
      for route in routes.values { route.proxy.close() }
    }
  }

  /// Binds the route's listener, on the profile's previous port when it is free, and points the
  /// tab's data store at it. Main queue.
  private func listen(_ profile: String, _ route: Route, done: @escaping (Bool) -> Void) {
    // Routes exist only on iOS 17, where routeAsync creates them.
    guard #available(iOS 17.0, *) else { done(false); return }
    let store = route.store
    let bound: (UInt16?) -> Void = { [weak self] port in
      DispatchQueue.main.async {
        guard let self, self.routes[profile] === route else { done(false); return }
        guard let port else {
          // Unrouted: pages load from the phone, as the caller is told.
          store.proxyConfigurations = []
          route.appliedPort = nil
          done(false)
          return
        }
        self.ports[profile] = port
        if route.appliedPort != port {
          var config = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!))
          if route.allHosts {
            // Network.framework matches these as domain suffixes and wants IPv6 literals bare.
            config.excludedDomains = route.directHosts.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "[]")) }
          } else {
            // For a server that cannot dial a named host: only localhost and *.localhost reach the proxy.
            config.matchDomains = ["localhost"]
          }
          store.proxyConfigurations = [config]
          route.appliedPort = port
        }
        done(true)
      }
    }
    let previous = ports[profile] ?? 0
    route.proxy.start(port: previous) { port in
      if port == nil, previous != 0 { route.proxy.start(port: 0, ready: bound) } else { bound(port) }
    }
  }
}
