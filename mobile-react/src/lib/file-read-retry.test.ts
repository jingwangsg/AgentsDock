import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { FileReadStatusError, isTunnelFailure, readFileWithRetry } from './file-read-retry'

// The retries wait seconds in the app; here each wait is recorded and ends at once.
function recordWaits(t: TestContext): number[] {
  const waits: number[] = []
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number) => {
    waits.push(delay)
    queueMicrotask(callback)
    return 0
  })
  return waits
}

const hubBody = (code: string) => async () => JSON.stringify({ detail: { code, remote_id: '044be05ef472', message: 'ReadError' } })

/** A read that fails with `failures` in turn, then returns 'file bytes'. */
function reads(...failures: unknown[]) {
  let calls = 0
  return {
    read: async () => {
      calls += 1
      if (failures.length) throw failures.shift()
      return 'file bytes'
    },
    calls: () => calls,
  }
}

test('the hub\'s tunnel failures are retryable; its other answers and the remote\'s are not', async () => {
  assert.equal(await isTunnelFailure(502, hubBody('remote_proxy_error')), true)
  assert.equal(await isTunnelFailure(502, hubBody('remote_unreachable')), true)
  assert.equal(await isTunnelFailure(504, hubBody('remote_timeout')), true)
  assert.equal(await isTunnelFailure(502, async () => '<html>Bad Gateway</html>'), false)
  assert.equal(await isTunnelFailure(503, async () => JSON.stringify({ detail: 'state is not ready' })), false)
  assert.equal(await isTunnelFailure(502, async () => { throw new Error('the body file is gone') }), false)
  let bodyRead = false
  assert.equal(await isTunnelFailure(404, async () => { bodyRead = true; return '{"detail":{"code":"remote_not_found"}}' }), false)
  assert.equal(bodyRead, false)
})

test('a read is sent again after a tunnel failure and dropped connections, 2, 4 and 8 s apart', async t => {
  const waits = recordWaits(t)
  const attempts = reads(
    new FileReadStatusError('File preview request failed with HTTP 502.', await isTunnelFailure(502, hubBody('remote_proxy_error'))),
    new TypeError('Network request failed'),
    new Error('unexpected end of stream on http://127.0.0.1:7850/...'),
  )

  assert.equal(await readFileWithRetry(attempts.read), 'file bytes')

  assert.equal(attempts.calls(), 4)
  assert.deepEqual(waits, [2_000, 4_000, 8_000])
})

test('a status-only 502 from expo-file-system\'s download counts as the hub\'s tunnel failure', async t => {
  const waits = recordWaits(t)
  const attempts = reads(new Error('Unable to download a file: response has status: 502'))

  assert.equal(await readFileWithRetry(attempts.read), 'file bytes')

  assert.deepEqual(waits, [2_000])
})

for (const [name, failure] of [
  ['a final HTTP answer', new FileReadStatusError('File download failed with HTTP 404.', false)],
  ['a status-only 404', new Error('Unable to download a file: response has status: 404')],
  ['a status-only 503, which the hub never sends', new Error('Unable to download a file: response has status: 503')],
  ['a refused connection', new Error('Failed to connect to /127.0.0.1:7850')],
  ['a local file error', new Error('Destination already exists')],
] as const) test(`${name} is thrown at once`, async t => {
  const waits = recordWaits(t)
  const attempts = reads(failure)

  await assert.rejects(readFileWithRetry(attempts.read), failure)

  assert.equal(attempts.calls(), 1)
  assert.deepEqual(waits, [])
})

test('the last failure is thrown after three retries', async t => {
  const waits = recordWaits(t)
  const failure = () => new FileReadStatusError('File download failed with HTTP 502.', true)
  const last = failure()
  const attempts = reads(failure(), failure(), failure(), last)

  await assert.rejects(readFileWithRetry(attempts.read), last)

  assert.equal(attempts.calls(), 4)
  assert.deepEqual(waits, [2_000, 4_000, 8_000])
})

test('cancelling during a wait ends the read at once', async t => {
  t.mock.method(globalThis, 'setTimeout', () => 0)
  const controller = new AbortController()
  const attempts = reads(new TypeError('Network request failed'))

  const pending = readFileWithRetry(attempts.read, { signal: controller.signal, onRetry: () => queueMicrotask(() => controller.abort()) })

  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(attempts.calls(), 1)
})
