package com.zhengyiluo.agentsdock.browserloopback

import android.os.Handler
import android.os.Looper
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

private const val MODULE_NAME = "AgentsDockBrowserLoopback"
// For a server that cannot dial a named host: with reverse bypass these are the only hosts sent to the
// proxy; every other page loads from the phone.
private val LOOPBACK_RULES = listOf("localhost", "*.localhost", "127.0.0.0/8", "[::1]")

/**
 * Sends the app's web views' requests to [LoopbackSocksProxy], so a browser tab's pages
 * load through the selected server's network: its localhost as on the desktop, and every
 * other host too when that server dials a named host (`allHosts`). Hosts the caller names
 * stay direct. The override is app-wide; one tab owns it at a time, and only that tab's
 * release clears it.
 */
class AgentsDockBrowserLoopbackModule : Module() {
  private val proxy = LoopbackSocksProxy(OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build())
  private val main = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name(MODULE_NAME)

    AsyncFunction("routeAsync") { tabId: String, tunnelPrefix: String, token: String, directHosts: List<String>, allHosts: Boolean, promise: Promise ->
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE) ||
        (!allHosts && !WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS))
      ) {
        promise.resolve(false)
        return@AsyncFunction
      }
      // Route and release may run on different threads; the lock keeps their overrides in call order.
      synchronized(proxy) {
        proxy.route = TunnelRoute(tabId, tunnelPrefix, token, allHosts)
        // Chromium hands a SOCKS5 proxy the host name unresolved (its bare socks:// is SOCKS5 too), so
        // names only the server's network knows are never looked up on the phone.
        val rules = ProxyConfig.Builder().addProxyRule("socks5://127.0.0.1:${proxy.start()}")
        val config = if (allHosts) {
          // Chromium's implicit "<-loopback>" bypass would otherwise send localhost pages to the phone itself.
          rules.removeImplicitRules().apply { directHosts.forEach { addBypassRule(it) } }.build()
        } else {
          // No removeImplicitRules() here: its "<-loopback>" rule evaluates to "exclude" for loopback
          // URLs, and in reverse-bypass mode Chromium's ProxyHostMatchingRules::Matches turns an
          // exclude into a direct connection, so localhost would skip the proxy. The explicit rules
          // already name every loopback host, and explicit matches are checked before the implicit ones.
          rules.apply { LOOPBACK_RULES.forEach { addBypassRule(it) } }.setReverseBypassEnabled(true).build()
        }
        main.post { ProxyController.getInstance().setProxyOverride(config, Runnable::run) { promise.resolve(true) } }
      }
    }

    AsyncFunction("releaseAsync") { tabId: String, promise: Promise ->
      synchronized(proxy) {
        if (proxy.route?.tabId != tabId) {
          promise.resolve(null)
          return@AsyncFunction
        }
        proxy.route = null
        proxy.stop()
        main.post { ProxyController.getInstance().clearProxyOverride(Runnable::run) { promise.resolve(null) } }
      }
    }

    OnDestroy { proxy.stop() }
  }
}
