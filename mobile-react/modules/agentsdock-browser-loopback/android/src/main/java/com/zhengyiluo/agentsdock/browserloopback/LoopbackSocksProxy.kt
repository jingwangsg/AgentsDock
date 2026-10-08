package com.zhengyiluo.agentsdock.browserloopback

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.encodeUtf8
import okio.ByteString.Companion.toByteString
import java.io.DataInputStream
import java.io.IOException
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

private const val TUNNEL_PROTOCOL = "agentsdock-port-tunnel-v1"
private const val TOKEN_PROTOCOL_PREFIX = "agentsdock-token."
private const val HANDSHAKE_TIMEOUT_MS = 10_000
private const val TUNNEL_OPEN_TIMEOUT_SECONDS = 15L
private const val READ_CHUNK_BYTES = 64 * 1024
// The server takes frames up to 1 MiB; past this much unsent data the local reader waits.
private const val SEND_HIGH_WATER_BYTES = 1024 * 1024L
private val IPV4_LITERAL = Regex("""\d{1,3}(\.\d{1,3}){3}""")

/**
 * Where connections go: one browser tab's port tunnel on the selected server. `allHosts`
 * when that server dials a named host; otherwise only loopback destinations are carried.
 */
data class TunnelRoute(val tabId: String, val tunnelPrefix: String, val token: String, val allHosts: Boolean)

/**
 * A SOCKS4/SOCKS5 listener on 127.0.0.1 that carries each CONNECT over the server's
 * port tunnel: one WebSocket per TCP connection, raw bytes both ways, the destination
 * port kept. A loopback destination is the server's own localhost; any other host is
 * named to the server, which resolves and dials it, when the route allows that. Nothing
 * is dialed from the phone; a destination the route excludes is refused.
 */
class LoopbackSocksProxy(private val http: OkHttpClient) {
  @Volatile var route: TunnelRoute? = null
  private var listener: ServerSocket? = null
  private val connections = ConcurrentHashMap.newKeySet<Socket>()
  private val workers = Executors.newCachedThreadPool { task -> Thread(task, "browser-loopback").apply { isDaemon = true } }

  /** Starts listening if needed and returns the port. */
  @Synchronized fun start(): Int {
    listener?.let { return it.localPort }
    val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    listener = socket
    workers.execute {
      while (!socket.isClosed) {
        val client = try { socket.accept() } catch (_: IOException) { break }
        connections.add(client)
        workers.execute { serve(client) }
      }
    }
    return socket.localPort
  }

  /** Stops listening and drops every open connection. */
  @Synchronized fun stop() {
    listener?.close()
    listener = null
    for (client in connections) closeQuietly(client)
    connections.clear()
  }

  private fun serve(client: Socket) {
    try {
      client.soTimeout = HANDSHAKE_TIMEOUT_MS
      val input = DataInputStream(client.getInputStream())
      val output = client.getOutputStream()
      val request = readConnectRequest(input, output) ?: return
      val route = route
      if (route == null || !(route.allHosts || isLoopback(request.host))) {
        request.reply(output, granted = false)
        return
      }
      val hostQuery = if (isLoopback(request.host)) "" else "?host=${URLEncoder.encode(request.host, "UTF-8")}"
      val bridge = TunnelBridge(client)
      val tunnel = http.newWebSocket(
        Request.Builder()
          .url("${route.tunnelPrefix}${request.port}/tunnel/ws$hostQuery")
          .header("Sec-WebSocket-Protocol", "$TUNNEL_PROTOCOL, $TOKEN_PROTOCOL_PREFIX${route.token.encodeUtf8().base64Url().trimEnd('=')}")
          .build(),
        bridge,
      )
      if (!bridge.awaitOpen()) {
        tunnel.cancel()
        request.reply(output, granted = false)
        return
      }
      request.reply(output, granted = true)
      client.soTimeout = 0
      val buffer = ByteArray(READ_CHUNK_BYTES)
      while (true) {
        val count = input.read(buffer)
        if (count < 0 || !tunnel.send(buffer.toByteString(0, count))) break
        while (tunnel.queueSize() > SEND_HIGH_WATER_BYTES && !bridge.finished) Thread.sleep(10)
      }
      tunnel.close(1000, "Local connection closed")
    } catch (_: IOException) {
    } catch (_: InterruptedException) {
    } finally {
      connections.remove(client)
      closeQuietly(client)
    }
  }
}

/** Writes what the server sends to the local connection, and ends it when the tunnel ends. */
private class TunnelBridge(private val client: Socket) : WebSocketListener() {
  private val opened = CountDownLatch(1)
  @Volatile private var accepted = false
  @Volatile var finished = false
    private set

  fun awaitOpen(): Boolean = opened.await(TUNNEL_OPEN_TIMEOUT_SECONDS, TimeUnit.SECONDS) && accepted

  override fun onOpen(webSocket: WebSocket, response: Response) {
    accepted = response.header("Sec-WebSocket-Protocol") == TUNNEL_PROTOCOL
    opened.countDown()
  }

  override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
    try {
      client.getOutputStream().write(bytes.toByteArray())
    } catch (_: IOException) {
      webSocket.cancel()
      finish()
    }
  }

  // The tunnel carries binary frames only.
  override fun onMessage(webSocket: WebSocket, text: String) {
    webSocket.close(1003, "Port tunnels carry binary frames only")
    finish()
  }

  override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
    webSocket.close(1000, null)
    finish()
  }

  override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish()

  override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = finish()

  private fun finish() {
    finished = true
    opened.countDown()
    closeQuietly(client)
  }
}

private class ConnectRequest(val version: Int, val host: String, val port: Int) {
  fun reply(output: OutputStream, granted: Boolean) {
    output.write(
      if (version == 4) byteArrayOf(0, if (granted) 0x5A else 0x5B, 0, 0, 0, 0, 0, 0)
      // SOCKS5 failure 0x02: connection not allowed by ruleset.
      else byteArrayOf(5, if (granted) 0 else 2, 0, 1, 0, 0, 0, 0, 0, 0),
    )
    output.flush()
  }
}

/** Reads a SOCKS4/4a or SOCKS5 (no authentication) CONNECT; null for anything else. */
private fun readConnectRequest(input: DataInputStream, output: OutputStream): ConnectRequest? {
  when (input.readUnsignedByte()) {
    4 -> {
      val command = input.readUnsignedByte()
      val port = input.readUnsignedShort()
      val address = ByteArray(4).also(input::readFully)
      readNulTerminated(input) // user id
      // SOCKS4a: an address of 0.0.0.x (x > 0) means the host name follows.
      val named = address[0] == 0.toByte() && address[1] == 0.toByte() && address[2] == 0.toByte() && address[3] != 0.toByte()
      val host = if (named) readNulTerminated(input) else InetAddress.getByAddress(address).hostAddress!!
      return if (command == 1) ConnectRequest(4, host, port) else null
    }
    5 -> {
      val methods = ByteArray(input.readUnsignedByte()).also(input::readFully)
      if (0.toByte() !in methods) {
        output.write(byteArrayOf(5, 0xFF.toByte()))
        return null
      }
      output.write(byteArrayOf(5, 0))
      output.flush()
      if (input.readUnsignedByte() != 5) return null
      val command = input.readUnsignedByte()
      input.readUnsignedByte() // reserved
      val host = when (input.readUnsignedByte()) {
        1 -> InetAddress.getByAddress(ByteArray(4).also(input::readFully)).hostAddress!!
        3 -> String(ByteArray(input.readUnsignedByte()).also(input::readFully), Charsets.US_ASCII)
        4 -> InetAddress.getByAddress(ByteArray(16).also(input::readFully)).hostAddress!!
        else -> return null
      }
      val port = input.readUnsignedShort()
      return if (command == 1) ConnectRequest(5, host, port) else null
    }
    else -> return null
  }
}

private fun readNulTerminated(input: DataInputStream): String {
  val bytes = StringBuilder()
  while (true) {
    val next = input.readUnsignedByte()
    if (next == 0) return bytes.toString()
    if (bytes.length >= 255) throw IOException("SOCKS field is too long")
    bytes.append(next.toChar())
  }
}

/** localhost names and loopback literals only; a name is never resolved here. */
internal fun isLoopback(host: String): Boolean {
  val name = host.lowercase().trimEnd('.').removePrefix("[").removeSuffix("]")
  if (name == "localhost" || name.endsWith(".localhost")) return true
  if (!IPV4_LITERAL.matches(name) && ':' !in name) return false
  return try { InetAddress.getByName(name).isLoopbackAddress } catch (_: IOException) { false }
}

private fun closeQuietly(socket: Socket) {
  try { socket.close() } catch (_: IOException) {}
}
