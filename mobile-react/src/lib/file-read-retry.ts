// Same codes and delays as electron/src/main/file-read-retry.ts; change both.

/**
 * The hub's remote proxy (server/remote_servers.py) answers 502 remote_unreachable while a remote's
 * ssh tunnel is down, 502 remote_proxy_error when the tunnel broke the request and 504
 * remote_timeout. The hub restarts the tunnel by itself. remote_not_found and every answer from
 * the remote itself are final.
 */
const TUNNEL_FAILURE_CODES = new Set(['remote_unreachable', 'remote_timeout', 'remote_proxy_error'])

/**
 * A dropped or timed-out connection as OkHttp on Android (10 s connect and read timeouts for
 * File.downloadFileAsync, 60 s for the legacy API) and NSURLSession on iOS (60 s) report it. fetch
 * reports every network failure as "Network request failed", a refused connection included, so
 * the text preview retries that too.
 */
const DROPPED_CONNECTION = /Network request failed|unexpected end of stream|connection reset|connection abort|broken pipe|stream was reset|socket closed|timeout|timed out|network connection was lost/i

/**
 * File.downloadFileAsync rejects a non-2xx answer with only "response has status: N", so the hub's
 * tunnel code is unreadable there; a 502 or 504 counts as the hub's tunnel failure. The AgentsServer
 * file, workspace and export download routes never answer those statuses themselves.
 */
const STATUS_ONLY_GATEWAY_FAILURE = /response has status:? 50[24]\b/

/**
 * Retries run 2, 6 and 14 s after the first failure. The hub restarts a dropped tunnel 2 s after
 * its ssh exits; on 2026-10-30 the tunnel was back 12.9 s after a failed read. A longer outage
 * shows the hub's 502/504 answer after about 14 s.
 */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000]

/** A read answered with an HTTP failure; `retryable` when the hub reported a tunnel failure. */
export class FileReadStatusError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
  }
}

/** True for the hub's answer to a tunnel failure: 502/503/504 with one of its tunnel codes. Reads `body` only then. */
export async function isTunnelFailure(status: number, body: () => Promise<string>): Promise<boolean> {
  if (status !== 502 && status !== 503 && status !== 504) return false
  try {
    const code = (JSON.parse(await body()) as { detail?: { code?: unknown } } | null)?.detail?.code
    return typeof code === 'string' && TUNNEL_FAILURE_CODES.has(code)
  } catch {
    return false
  }
}

/**
 * Runs `read` again after a tunnel failure or a dropped connection, up to 3 times over about
 * 14 s. Any other failure, a cancellation, or the last attempt's failure is thrown as it is.
 */
export async function readFileWithRetry<T>(read: () => Promise<T>, options: { signal?: AbortSignal; onRetry?: () => void } = {}): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read()
    } catch (cause) {
      if (attempt === RETRY_DELAYS_MS.length || options.signal?.aborted || !retryable(cause)) throw cause
    }
    options.onRetry?.()
    await wait(RETRY_DELAYS_MS[attempt], options.signal)
  }
}

function retryable(cause: unknown): boolean {
  if (cause instanceof FileReadStatusError) return cause.retryable
  const message = cause instanceof Error ? cause.message : String(cause)
  return DROPPED_CONNECTION.test(message) || STATUS_ONLY_GATEWAY_FAILURE.test(message)
}

function wait(delay: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      clearTimeout(timer)
      const error = new Error('The file read was cancelled.')
      error.name = 'AbortError'
      reject(error)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancelled)
      resolve()
    }, delay)
    if (signal?.aborted) cancelled()
    else signal?.addEventListener('abort', cancelled, { once: true })
  })
}
