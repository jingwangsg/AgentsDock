import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import type { Session, StoredProfileSettings } from '../types'

// One hub serves itself at `/` and its remote r1 at `/api/remote/r1`; a second
// server stands for a directly addressed profile.
const identities: Record<string, string> = { hub: 'server-hub', r1: 'remote-old', direct: 'direct-new' }

function mockServer(route: (path: string) => { key: string; path: string } | null): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const target = route(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (!target) return reply(404, { detail: 'Unhandled test endpoint' })
    if (target.path === '/api/health') {
      return reply(200, { ok: true, server_identity: identities[target.key], server_version: 'hub-identity-test', api_contract_version: 8, active_sessions: [] })
    }
    if (target.path === '/api/sessions') return reply(200, { sessions: [session(target.key)] })
    if (target.path === '/api/runtime/catalog') return reply(200, { backends: {} })
    if (target.path === '/api/jobs') return reply(200, { jobs: [] })
    reply(404, { detail: `Unhandled test endpoint: ${target.path}` })
  })
}

function session(key: string): Session {
  return {
    id: `chat-${key}`,
    title: `Chat on ${identities[key]}`,
    backend: 'codex',
    archived: false,
    created_at: '2026-09-30T10:00:00Z',
    updated_at: '2026-09-30T10:00:00Z',
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

const hub = mockServer(path => {
  const remote = /^\/api\/remote\/r1(\/.*)$/.exec(path)
  return remote ? { key: 'r1', path: remote[1] } : { key: 'hub', path }
})
const direct = mockServer(path => ({ key: 'direct', path }))
const originalSetInterval = globalThis.setInterval

try {
  const [hubURL, directURL] = await Promise.all([listen(hub), listen(direct)])
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore()
  ;(Notifications as typeof Notifications & { __resetNotifications(): void }).__resetNotifications()

  const timestamp = '2026-09-30T10:00:00.000Z'
  const profile = (id: string, serverURL: string, serverIdentity: string) => ({
    id, name: id, serverURL, serverIdentity, serverConfigured: true, credentialVersion: 1, createdAt: timestamp, updatedAt: timestamp,
  })
  const settings: StoredProfileSettings = {
    schemaVersion: 2,
    activeProfileId: 'remote',
    profiles: [
      profile('hub', hubURL, 'server-hub'),
      profile('remote', `${hubURL}/api/remote/r1`, 'remote-old'),
      profile('direct', directURL, 'direct-old'),
    ],
    fontScale: 1,
  }
  await AsyncStorage.setItem('agentsdock.react.settings.v2', JSON.stringify(settings))
  const cache = await import('../storage/cache')
  for (const { id } of settings.profiles) await SecureStore.setItemAsync(cache.profileTokenKey(id, 1), 'token')
  await cache.saveCachedSessions('remote-old', [{ ...session('r1'), id: 'chat-old', title: 'Chat on the old machine' }])

  globalThis.setInterval = (() => 1) as unknown as typeof setInterval
  const { useAppStore } = await import('./useAppStore')
  const remoteProfile = () => useAppStore.getState().profiles.find(value => value.id === 'remote')
  const savedIdentity = async (id: string) => (JSON.parse(await AsyncStorage.getItem('agentsdock.react.settings.v2') ?? '{}') as StoredProfileSettings)
    .profiles.find(value => value.id === id)?.serverIdentity

  // The active remote was moved: the hub now routes r1 to a fresh install.
  identities.r1 = 'remote-new'
  await useAppStore.getState().initialize()
  await waitFor(() => useAppStore.getState().sessions[0]?.title === 'Chat on remote-new', 'the active hub remote did not reconnect under its new identity')
  let state = useAppStore.getState()
  assert.equal(state.activeProfileId, 'remote')
  assert.equal(state.connected, true)
  assert.equal(remoteProfile()?.serverIdentity, 'remote-new')
  assert.equal(state.error, null)
  assert.equal(remoteProfile()?.lastConnectionError, null)
  assert.deepEqual(state.sessions.map(value => value.title), ['Chat on remote-new'])
  assert.equal(await savedIdentity('remote'), 'remote-new')

  // Moved again while another profile is active: selecting it accepts the new identity too.
  assert.equal(await useAppStore.getState().switchServerProfile('hub'), true)
  await waitFor(() => useAppStore.getState().connected && useAppStore.getState().activeProfileId === 'hub', 'the hub did not connect')
  identities.r1 = 'remote-newer'
  assert.equal(await useAppStore.getState().switchServerProfile('remote'), true)
  await waitFor(() => useAppStore.getState().sessions[0]?.title === 'Chat on remote-newer', 'a selected hub remote did not reconnect under its new identity')
  state = useAppStore.getState()
  assert.equal(state.connected, true)
  assert.equal(remoteProfile()?.serverIdentity, 'remote-newer')
  assert.equal(state.error, null)
  assert.deepEqual(state.sessions.map(value => value.title), ['Chat on remote-newer'])
  assert.equal(await savedIdentity('remote'), 'remote-newer')

  // A directly addressed server keeps its pinned identity until the user confirms the change.
  await useAppStore.getState().switchServerProfile('direct')
  await waitFor(() => /identity mismatch/i.test(useAppStore.getState().error ?? ''), 'a direct profile identity change was not refused')
  await new Promise(resolve => setTimeout(resolve, 100))
  state = useAppStore.getState()
  assert.equal(state.connected, false)
  assert.equal(state.profiles.find(value => value.id === 'direct')?.serverIdentity, 'direct-old')
  assert.equal(await savedIdentity('direct'), 'direct-old')

  // Inactive servers get a live status dot from the background probe.
  assert.equal(await useAppStore.getState().switchServerProfile('hub'), true)
  await waitFor(() => useAppStore.getState().connected && useAppStore.getState().activeProfileId === 'hub', 'the hub did not reconnect')
  await useAppStore.getState().probeInactiveProfiles()
  state = useAppStore.getState()
  assert.equal(remoteProfile()?.connectionState, 'online')
  // A changed identity is left for selection to settle, not reported as online.
  assert.equal(state.profiles.find(value => value.id === 'direct')?.connectionState, 'cached')
  direct.closeAllConnections?.()
  await new Promise<void>(resolve => direct.close(() => resolve()))
  await useAppStore.getState().probeInactiveProfiles()
  assert.equal(useAppStore.getState().profiles.find(value => value.id === 'direct')?.connectionState, 'offline')

  console.log('hub remote identity store regressions passed')
} finally {
  globalThis.setInterval = originalSetInterval
  for (const server of [hub, direct]) {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
