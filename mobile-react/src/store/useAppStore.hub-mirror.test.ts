import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import type { StoredProfileSettings } from '../types'

// The server list mirrors the hub by remote id, whatever address the hub was saved under. One hub lists r1 and r2;
// another hub (saved here too) and an unsaved hub's leftover profile must never be merged or removed.
const remotes = ['r1', 'r2']
const listings: string[] = []

function hubServer(): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (String(request.headers['x-zenithdock-token'] ?? request.headers['x-agentsdock-token'] ?? '') !== 'hub-token') return reply(401, { detail: 'invalid token' })
    const remote = /^\/api\/remote\/(r\d)(\/.*)$/.exec(path)
    if (remote && remote[2] === '/api/health') return reply(200, { ok: true, server_identity: `remote-${remote[1]}`, server_instance_id: `${remote[1]}-1`, api_contract_version: 8, active: [] })
    if (path === '/api/health') {
      return reply(200, {
        ok: true, server_identity: 'server-hub', server_instance_id: 'hub-1', api_contract_version: 8, active: [],
        capabilities: { remote_servers_v1: { available: true, ids: remotes, hidden: [], names: remotes } },
      })
    }
    if (path === '/api/admin/remote-servers') {
      listings.push(path)
      return reply(200, { servers: remotes.map(id => ({ id, name: id, ssh_host: id, install_dir: '', remote_port: 0, local_port: 0, created_at: '2026-11-03T00:00:00Z', proxy_path: `/api/remote/${id}`, tunnel: null, hidden: false })) })
    }
    if (path === '/api/sessions') return reply(200, { sessions: [] })
    if (path === '/api/runtime/catalog') return reply(200, { backends: {} })
    if (path === '/api/jobs') return reply(200, { jobs: [] })
    reply(404, { detail: `Unhandled test endpoint: ${path}` })
  })
}

async function waitFor(condition: () => boolean | Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(message)
}

const hub = hubServer()
const originalSetInterval = globalThis.setInterval
try {
  await new Promise<void>(resolve => hub.listen(0, '127.0.0.1', resolve))
  const address = hub.address()
  assert(address && typeof address === 'object')
  const hubURL = `http://127.0.0.1:${address.port}`
  const oldHubURL = 'http://192.0.2.10:7850'
  const otherHubURL = 'http://198.51.100.9:7850'
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore()
  ;(Notifications as typeof Notifications & { __resetNotifications(): void }).__resetNotifications()

  const timestamp = '2026-11-03T05:31:00.000Z'
  const profile = (id: string, serverURL: string, serverIdentity: string | null) => ({
    id, name: id, serverURL, serverIdentity, serverConfigured: true, credentialVersion: 1, createdAt: timestamp, updatedAt: timestamp,
  })
  // The phone of 2026-11-03: the hub was saved under its Tailscale address, then changed to its LAN address, and an
  // older build saved every remote again under the new one.
  const settings: StoredProfileSettings = {
    schemaVersion: 2,
    activeProfileId: 'local',
    profiles: [
      profile('local', hubURL, 'server-hub'),
      profile('old-r1', `${oldHubURL}/api/remote/r1`, 'remote-r1'),
      profile('old-r2', `${oldHubURL}/api/remote/r2`, 'remote-r2'),
      profile('new-r1', `${hubURL}/api/remote/r1`, null),
      profile('new-r2', `${hubURL}/api/remote/r2`, null),
      profile('hub-b', otherHubURL, 'server-hub-b'),
      profile('b-r1', `${otherHubURL}/api/remote/r1`, 'remote-b-r1'),
      // Left by a hub that is no longer saved here: same remote id as this hub's r2, another token.
      profile('foreign', 'http://203.0.113.5:7850/api/remote/r2', 'remote-foreign'),
    ],
    fontScale: 1,
  }
  await AsyncStorage.setItem('agentsdock.react.settings.v2', JSON.stringify(settings))
  const cache = await import('../storage/cache')
  const tokens: Record<string, string> = { 'hub-b': 'b-token', 'b-r1': 'b-token', foreign: 'other-token' }
  for (const { id } of settings.profiles) await SecureStore.setItemAsync(cache.profileTokenKey(id, 1), tokens[id] ?? 'hub-token')
  // old-r1 holds this device's chats of r1; new-r2 has a draft while old-r2 has nothing.
  await cache.saveCachedSessions('remote-r1', [{ id: 'chat-1', title: 'Chat on r1', backend: 'codex', archived: false, created_at: timestamp, updated_at: timestamp }])
  await cache.saveWorkspacePreferences('profile:new-r2', { selectedSessionId: null, folderOrder: [], collapsedFolders: [], drafts: { 'chat-2': 'unsent' } })

  globalThis.setInterval = (() => 1) as unknown as typeof setInterval
  const { useAppStore } = await import('./useAppStore')
  const saved = async () => (JSON.parse(await AsyncStorage.getItem('agentsdock.react.settings.v2') ?? '{}') as StoredProfileSettings).profiles
  const urls = (profiles: readonly { id: string; serverURL: string }[]) => Object.fromEntries(profiles.map(value => [value.id, value.serverURL]))

  // Connecting to the hub mirrors its registry: each remote keeps one profile under the hub's address.
  await useAppStore.getState().initialize()
  await waitFor(async () => (await saved()).length === 6, 'the duplicates were not collapsed')
  const collapsed = {
    local: hubURL,
    'old-r1': `${hubURL}/api/remote/r1`,
    'new-r2': `${hubURL}/api/remote/r2`,
    'hub-b': otherHubURL,
    'b-r1': `${otherHubURL}/api/remote/r1`,
    foreign: 'http://203.0.113.5:7850/api/remote/r2',
  }
  assert.deepEqual(urls(await saved()), collapsed, 'the one with this device\'s chats or drafts stays, under the hub\'s address')
  assert.deepEqual(urls(useAppStore.getState().profiles), collapsed)
  assert.equal(useAppStore.getState().profiles.find(value => value.id === 'old-r1')?.serverIdentity, 'remote-r1', 'the kept profile keeps its identity and cache')
  assert.equal(await SecureStore.getItemAsync(cache.profileTokenKey('new-r1', 1)), null, 'a dropped duplicate\'s token is deleted')
  assert.equal(await SecureStore.getItemAsync(cache.profileTokenKey('old-r2', 1)), null)
  assert.equal(await SecureStore.getItemAsync(cache.profileTokenKey('foreign', 1)), 'other-token', 'another hub\'s leftover keeps its token')

  // Changing the hub's address (LAN to Tailscale and back) moves its remotes with it and creates none.
  const movedHubURL = `http://localhost:${address.port}`
  await useAppStore.getState().updateServerProfile('local', { serverURL: movedHubURL })
  const listingsBefore = listings.length
  await waitFor(() => listings.length > listingsBefore && useAppStore.getState().connected, 'the hub did not reconnect and mirror its registry')
  await useAppStore.getState().refreshSessions()
  const moved = {
    ...collapsed,
    local: movedHubURL,
    'old-r1': `${movedHubURL}/api/remote/r1`,
    'new-r2': `${movedHubURL}/api/remote/r2`,
  }
  assert.deepEqual(urls(await saved()), moved, 'no profile is created or left behind under the old address')
  assert.deepEqual(urls(useAppStore.getState().profiles), moved)
} finally {
  globalThis.setInterval = originalSetInterval
  hub.closeAllConnections?.()
  await new Promise<void>(resolve => hub.close(() => resolve()))
}

console.log('hub mirror store regressions passed')
