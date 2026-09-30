import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import type { Session, StoredProfileSettings } from '../types'

// One hub serves itself at `/` and its remote r1 at `/api/remote/r1`; a second
// server stands for a directly addressed profile.
const identities: Record<string, string> = { hub: 'server-hub', r1: 'remote-old', direct: 'direct-new' }
let catalogAvailable = true
const running: Record<string, string[]> = {}
const redeployRequests: string[] = []
const healthDown = new Set<string>()

function mockServer(route: (path: string) => { key: string; path: string } | null): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const target = route(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (!target) return reply(404, { detail: 'Unhandled test endpoint' })
    if (target.path === '/api/health') {
      if (healthDown.has(target.key)) return reply(502, { detail: 'remote_unreachable' })
      return reply(200, { ok: true, server_identity: identities[target.key], server_version: 'hub-identity-test', api_contract_version: 8, active_sessions: [], active: running[target.key] ?? [] })
    }
    if (request.method === 'POST' && target.path === '/api/admin/remote-servers/r1/redeploy') {
      redeployRequests.push('r1')
      return reply(202, { job_id: 'job-1' })
    }
    if (target.path === '/api/admin/remote-servers/deploy/job-1') {
      return reply(200, { job_id: 'job-1', phase: 'complete', done: true, error: null, server: null, log: [{ phase: 'upload', message: 'Uploading' }, { phase: 'complete', message: 'Reachable' }] })
    }
    if (request.method === 'POST' && target.path === '/api/admin/runtimes/codex/update') {
      return reply(200, { output: 'npm install\ncodex-cli 9.9.9', diagnostic: { available: true, version: '9.9.9' } })
    }
    if (target.path === '/api/sessions') return reply(200, { sessions: [session(target.key)] })
    if (target.path === '/api/runtime/catalog') return catalogAvailable ? reply(200, { backends: {} }) : reply(503, { detail: 'catalog unavailable' })
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

  let refreshTick: (() => void) | undefined
  globalThis.setInterval = ((handler: () => void, delay?: number) => { if (delay === 60_000) refreshTick = handler; return 1 }) as unknown as typeof setInterval
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

  // Server list actions run on the right server whichever one is active: Redeploy on the hub (asking
  // first while the remote has running chats), Update CLI on the chosen server itself.
  running.r1 = ['chat-busy']
  assert.deepEqual(await useAppStore.getState().redeployHubRemote('remote', false, () => undefined), { redeployed: false, running: 1 })
  healthDown.add('r1')
  assert.deepEqual(await useAppStore.getState().redeployHubRemote('remote', false, () => undefined), { redeployed: false, running: null }, 'an unreachable remote is not assumed idle')
  healthDown.delete('r1')
  assert.deepEqual(redeployRequests, [])
  const progress: string[] = []
  assert.deepEqual(await useAppStore.getState().redeployHubRemote('remote', true, entry => progress.push(entry.message)), { redeployed: true, running: 0 })
  assert.deepEqual(redeployRequests, ['r1'])
  assert.deepEqual(progress, ['Uploading', 'Reachable'])
  await assert.rejects(useAppStore.getState().redeployHubRemote('direct', true, () => undefined), /Only servers the hub deployed/)
  assert.equal(await useAppStore.getState().updateServerCli('hub', 'codex'), 'codex-cli 9.9.9')
  identities.hub = 'server-replaced'
  await assert.rejects(useAppStore.getState().updateServerCli('hub', 'codex'), /different identity/)
  identities.hub = 'server-hub'

  // A catalog that failed at connect is loaded again by the next refresh tick; without it every
  // chat reads "Server model" and the model picker stays disabled.
  catalogAvailable = false
  assert.equal(await useAppStore.getState().switchServerProfile('remote'), true)
  await waitFor(() => useAppStore.getState().connected && useAppStore.getState().activeProfileId === 'remote', 'the remote did not reconnect')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(useAppStore.getState().runtime, null)
  refreshTick!()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(useAppStore.getState().error, null, 'a failed background catalog retry must not raise the error banner')
  catalogAvailable = true
  refreshTick!()
  await waitFor(() => useAppStore.getState().runtime !== null, 'a missing catalog was not loaded again')

  console.log('hub remote identity store regressions passed')
} finally {
  globalThis.setInterval = originalSetInterval
  for (const server of [hub, direct]) {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
