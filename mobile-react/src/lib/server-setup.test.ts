import { AGENTS_SERVER_REPOSITORY_URL, inferServerConfigured, localHubAlive } from './server-setup'

function assertEqual(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, received ${String(actual)}`)
}

assertEqual(inferServerConfigured(undefined, undefined), false)
assertEqual(inferServerConfigured('', undefined), false)
assertEqual(inferServerConfigured('127.0.0.1:7850', undefined), false)
assertEqual(inferServerConfigured('http://localhost:7850/', undefined), false)
// normalizeServerURL now defaults http addresses to port 7850, so the bare
// loopback hosts must still read as "not configured".
assertEqual(inferServerConfigured('127.0.0.1', undefined), false)
assertEqual(inferServerConfigured('localhost', undefined), false)
assertEqual(inferServerConfigured('100.64.0.1:7850', undefined), true)
assertEqual(inferServerConfigured('http://127.0.0.1:7850', true), true)
assertEqual(inferServerConfigured('100.64.0.1:7850', false), false)
assertEqual(AGENTS_SERVER_REPOSITORY_URL, 'https://github.com/ZhengyiLuo/AgentsServer')

const unauthorized = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
const refused = (async () => { throw new TypeError('Network request failed') }) as unknown as typeof fetch
const hanging = ((_url: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
})) as unknown as typeof fetch
void (async () => {
  assertEqual(await localHubAlive('127.0.0.1', unauthorized), true)
  assertEqual(await localHubAlive('http://127.0.0.1:7850', refused), false)
  assertEqual(await localHubAlive('127.0.0.1', hanging, 20), false)
  console.log('server setup regressions passed')
})()
