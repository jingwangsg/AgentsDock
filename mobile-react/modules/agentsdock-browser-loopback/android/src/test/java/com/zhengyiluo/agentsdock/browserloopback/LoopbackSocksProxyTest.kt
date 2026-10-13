package com.zhengyiluo.agentsdock.browserloopback

import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class LoopbackSocksProxyTest {
  private val server = MockWebServer()
  private val proxy = LoopbackSocksProxy(OkHttpClient())

  @After fun tearDown() {
    proxy.stop()
    server.shutdown()
  }

  @Test fun stopClosesOpenTunnels() {
    val ended = CountDownLatch(1)
    server.enqueue(
      MockResponse()
        .setHeader("Sec-WebSocket-Protocol", "agentsdock-port-tunnel-v1")
        .withWebSocketUpgrade(object : WebSocketListener() {
          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null) // as the server does; MockWebServer.shutdown() waits for it
            ended.countDown()
          }
          override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = ended.countDown()
        }),
    )
    proxy.route = TunnelRoute("browser_test", server.url("/api/sessions/browser_test/ports/").toString(), "token", allHosts = false)

    val page = Socket("127.0.0.1", proxy.start())
    val input = DataInputStream(page.getInputStream())
    // SOCKS5 greeting offering only "no authentication"; the proxy accepts it.
    page.getOutputStream().write(byteArrayOf(5, 1, 0))
    assertEquals(listOf<Byte>(5, 0), ByteArray(2).also(input::readFully).toList())
    // CONNECT localhost:8265 by name (address type 3); reply byte 1 is the status, 0 = granted.
    val host = "localhost".toByteArray()
    page.getOutputStream().write(byteArrayOf(5, 1, 0, 3, host.size.toByte()) + host + byteArrayOf(0x20, 0x49))
    assertEquals(0.toByte(), ByteArray(10).also(input::readFully)[1])

    // The module's releaseAsync calls stop() while the page may still hold an idle connection.
    proxy.stop()

    assertTrue("the server-side tunnel stayed open", ended.await(5, TimeUnit.SECONDS))
  }
}
