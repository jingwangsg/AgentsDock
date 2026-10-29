import { setTimeout as sleep } from 'node:timers/promises'
import { appLog } from './logger'
import { networkErrorDetails } from './network-error'

// Same codes and delays as mobile-react/src/lib/file-read-retry.ts; change both.

/**
 * The hub's remote proxy (server/remote_servers.py) answers 502 remote_unreachable while a remote's
 * ssh tunnel is down, 502 remote_proxy_error when the tunnel broke the request and 504
 * remote_timeout. The hub restarts the tunnel by itself. remote_not_found and every answer from
 * the remote itself are final.
 */
const TUNNEL_FAILURE_CODES = new Set(['remote_unreachable', 'remote_timeout', 'remote_proxy_error'])

/**
 * Node's fetch (undici) fails with a TypeError whose cause carries one of these when the
 * connection resets, closes mid-response or cannot connect in time. A refused connection
 * (ECONNREFUSED) means no server listens there and is final. So are undici's 300 s header and
 * body timeouts: ssh drops a dead tunnel within 30 s and the hub then closes the connection,
 * so a 300 s silence is a frozen remote, and three retries would add 15 minutes.
 */
const DROPPED_CONNECTION_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_CONNECT_TIMEOUT'
])

/**
 * Retries run 2, 6 and 14 s after the first failure. The hub restarts a dropped tunnel 2 s after
 * its ssh exits; on 2026-10-30 the tunnel was back 12.9 s after a failed read. A longer outage
 * shows the hub's 502/504 answer after about 14 s.
 */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000]

/**
 * Reads a chat file through `send` and `read`, and sends again after the hub reported a dropped
 * tunnel or the connection dropped, before the answer or while `read` consumed the body. Once
 * the retries run out, `read` gets the hub's failure response like any other answer.
 */
export async function readFileWithRetry<T>(
  send: () => Promise<Response>,
  read: (response: Response) => Promise<T> | T,
  signal?: AbortSignal
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const retriesLeft = attempt < RETRY_DELAYS_MS.length
    try {
      const response = await send()
      const code = retriesLeft ? await tunnelFailureCode(response) : null
      if (!code) return await read(response)
      await response.body?.cancel().catch(() => undefined)
      appLog('files', 'retrying a file read after a tunnel failure', { status: response.status, code, retry: attempt + 1 })
    } catch (error) {
      if (!retriesLeft || !isDroppedConnection(error)) throw error
      appLog('files', 'retrying a file read after a dropped connection', { error: networkErrorDetails(error), retry: attempt + 1 })
    }
    await sleep(RETRY_DELAYS_MS[attempt], undefined, { signal })
  }
}

async function tunnelFailureCode(response: Response): Promise<string | null> {
  if (response.status !== 502 && response.status !== 503 && response.status !== 504) return null
  // The hub's answers are small JSON; any other body (a remote's own stream, a proxy's page) is final.
  if (!response.headers.get('content-type')?.startsWith('application/json')) return null
  try {
    // A clone, so the caller can still read the body of a response that is not retried.
    const code = (JSON.parse(await response.clone().text()) as { detail?: { code?: unknown } } | null)?.detail?.code
    return typeof code === 'string' && TUNNEL_FAILURE_CODES.has(code) ? code : null
  } catch {
    return null
  }
}

function isDroppedConnection(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false
  const code = (error.cause as { code?: unknown } | undefined)?.code
  return typeof code === 'string' && DROPPED_CONNECTION_CODES.has(code)
}
