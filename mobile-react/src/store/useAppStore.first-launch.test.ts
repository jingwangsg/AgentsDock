import assert from 'node:assert/strict'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import { AppState as NativeAppState } from 'react-native'

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function after(milliseconds: number): Promise<'timeout'> {
  return new Promise(resolve => setTimeout(() => resolve('timeout'), milliseconds))
}

await AsyncStorage.clear()
;(SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore()
;(Notifications as typeof Notifications & { __resetNotifications(): void }).__resetNotifications()

const originalFetch = globalThis.fetch
const originalSetInterval = globalThis.setInterval
let fetchCalls = 0
const fetchedURLs: string[] = []
let refreshTick: () => void = () => {}

// Nothing listens on the placeholder address in this test: the one launch probe
// must fail fast (connection refused), never hang on a health timeout.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetchCalls += 1
  fetchedURLs.push(String(input))
  throw new TypeError('Network request failed')
}) as typeof fetch
globalThis.setInterval = ((handler: TimerHandler) => {
  refreshTick = typeof handler === 'function' ? () => { handler() } : () => {}
  return 1
}) as unknown as typeof setInterval

try {
  const { useAppStore } = await import('./useAppStore')
  const initialized = await Promise.race([
    useAppStore.getState().initialize().then(() => 'initialized' as const),
    after(750),
  ])
  assert.equal(initialized, 'initialized', 'fresh local bootstrap must not wait for a server health timeout')

  let state = useAppStore.getState()
  assert.equal(state.initialized, true)
  assert.equal(state.activeProfileId, 'default-profile')
  assert.equal(state.serverConfigured, false)
  assert.equal(state.connecting, false)
  assert.equal(state.connected, false)
  assert.equal(state.error, null)
  // A phone usually reaches the hub through a local forward, so the placeholder is probed exactly once on launch.
  assert.equal(fetchCalls, 1, 'fresh launch probes the 127.0.0.1:7850 placeholder once')
  assert.equal(fetchedURLs[0], 'http://127.0.0.1:7850/api/health')

  await state.reconnect()
  refreshTick()
  await nextTurn()
  assert.equal(fetchCalls, 1, 'manual and periodic reconnect paths must ignore an unconfigured placeholder')

  const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }
  appState.__emitAppState('background')
  appState.__emitAppState('active')
  await nextTurn()
  state = useAppStore.getState()
  assert.equal(state.connecting, false)
  assert.equal(fetchCalls, 1, 'foreground reconciliation must not probe an unconfigured placeholder')
} finally {
  globalThis.fetch = originalFetch
  globalThis.setInterval = originalSetInterval
}

console.log('first-launch store regressions passed')
