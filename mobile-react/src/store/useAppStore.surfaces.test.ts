import assert from 'node:assert/strict'
import { AppState as NativeAppState } from 'react-native'
import type { Health, PublicServerProfile, Session, Surface } from '../types'
import { client, useAppStore } from './useAppStore'

const timestamp = '2026-10-03T12:00:00.000Z'
const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, title: `Title ${id}`, backend: 'codex', archived: false, created_at: timestamp, updated_at: timestamp,
  latest_event_seq: 1, latest_agent_event_seq: 1, last_read_agent_event_seq: 1, manual_unread: false, ...patch,
})
const surface = (patch: Partial<Surface>): Surface => ({
  id: 'term_1', kind: 'terminal', name: null, folder: 'Research', cwd: '/work/research', url: null, page_title: null,
  created_at: timestamp, updated_at: timestamp, ...patch,
})
const profile = (id: string, serverURL: string, serverIdentity: string): PublicServerProfile => ({
  id, name: id, serverURL, serverIdentity, serverConfigured: true,
  credentialVersion: 1, createdAt: timestamp, updatedAt: timestamp,
  hasAccessToken: false, connectionState: 'online', cachedUnreadCount: 0,
})
let health: Health = { ok: true, server_identity: 'uninitialized', api_contract_version: 8, active: [], default_cwd: '/home/default', surfaces_revision: 1 }
const chats = [
  session('chat-old', { folder: 'Research', cwd: '/work/older', created_at: '2026-09-01T00:00:00Z' }),
  session('chat-new', { folder: 'Research', cwd: '/work/newer', created_at: '2026-09-02T00:00:00Z' }),
]
let stored: Surface[] = [surface({ id: 'term_1' }), surface({ id: 'browser_1', kind: 'browser', folder: 'General', cwd: null, url: 'https://docs.example', page_title: 'Docs' })]
const calls: Array<[string, unknown]> = []
let listCalls = 0

const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }
client.markValidated()
client.health = async () => health
client.sessions = async () => chats
client.listSurfaces = async () => { listCalls += 1; return stored }
client.createSurface = async input => {
  calls.push(['create', input])
  return surface({ id: `${input.kind === 'terminal' ? 'term' : 'browser'}_new`, kind: input.kind, folder: input.folder, cwd: input.cwd ?? null })
}
client.updateSurface = async (id, patch) => {
  calls.push(['update', [id, patch]])
  return { ...stored.find(item => item.id === id)!, ...patch, updated_at: '2026-10-04T00:00:00Z' }
}
client.deleteSurface = async id => { calls.push(['delete', id]) }
client.sessionPage = async () => { throw new Error('not needed') }
globalThis.fetch = async () => { throw new Error('Unexpected network request in surfaces regression') }

appState.__emitAppState('active')
useAppStore.setState({
  initialized: true,
  activeProfileId: 'uninitialized',
  profiles: [profile('uninitialized', 'http://127.0.0.1:7850', 'uninitialized'), profile('other', 'https://other.example', 'identity-other')],
  profileGeneration: 0,
  serverConfigured: true,
  connected: true,
  connecting: false,
  workspaceAdopting: false,
  health,
  sessions: chats,
  selectedSessionId: null,
  surfaces: [],
  selectedSurfaceId: 'term_gone',
  error: null,
  reconnect: async () => {
    client.markValidated()
    useAppStore.setState({ connected: true, connecting: false })
  },
})

// Reading the server's tabs forgets a selection that is gone.
await useAppStore.getState().refreshSurfaces()
assert.deepEqual(useAppStore.getState().surfaces.map(item => item.id), ['term_1', 'browser_1'])
assert.equal(useAppStore.getState().selectedSurfaceId, null)

// The chat-list refresh re-reads tabs only when the server's revision moved.
listCalls = 0
await useAppStore.getState().refreshSessions()
assert.equal(listCalls, 0, 'an unchanged revision spares the fetch')
health = { ...health, surfaces_revision: 2 }
await useAppStore.getState().refreshSessions()
assert.equal(listCalls, 1, 'a moved revision re-reads the tabs')
await useAppStore.getState().refreshSessions()
assert.equal(listCalls, 1)
// Connecting and the runtime refresh store health too; a revision they saw first still loads the tabs.
health = { ...health, surfaces_revision: 3 }
useAppStore.setState({ health })
await useAppStore.getState().refreshSessions()
assert.equal(listCalls, 2, 'a revision stored by another health reader still re-reads the tabs')
// After a server switch nothing is loaded yet, whatever health already says.
useAppStore.setState({ surfaces: [], surfacesRevision: null, health })
await useAppStore.getState().refreshSessions()
assert.equal(listCalls, 3, 'the first poll on a server loads its tabs')
assert.deepEqual(useAppStore.getState().surfaces.map(item => item.id), ['term_1', 'browser_1'])

// A new terminal starts in the folder's newest chat directory and is selected.
assert.equal(await useAppStore.getState().createSurface('terminal', 'Research'), true)
assert.deepEqual(calls.at(-1), ['create', { kind: 'terminal', folder: 'Research', cwd: '/work/newer' }])
assert.equal(useAppStore.getState().selectedSurfaceId, 'term_new')
assert.equal(await useAppStore.getState().createSurface('browser', 'Ideas'), true)
assert.deepEqual(calls.at(-1), ['create', { kind: 'browser', folder: 'Ideas', cwd: null }])
assert.equal(await useAppStore.getState().createSurface('terminal', 'Ideas'), true)
assert.deepEqual(calls.at(-1), ['create', { kind: 'terminal', folder: 'Ideas', cwd: '/home/default' }])

// Renames and page records go through the server; the server's copy wins.
await useAppStore.getState().updateSurface('browser_1', { name: 'GitHub' })
assert.deepEqual(calls.at(-1), ['update', ['browser_1', { name: 'GitHub' }]])
assert.equal(useAppStore.getState().surfaces.find(item => item.id === 'browser_1')?.updated_at, '2026-10-04T00:00:00Z')

// Selecting a tab, then a chat, leaves the tab.
useAppStore.getState().selectSurface('browser_1')
assert.equal(useAppStore.getState().selectedSurfaceId, 'browser_1')
useAppStore.getState().selectSurface('nope')
assert.equal(useAppStore.getState().selectedSurfaceId, null)
useAppStore.getState().selectSurface('browser_1')
void useAppStore.getState().selectSession('chat-new').catch(() => undefined)
assert.equal(useAppStore.getState().selectedSessionId, 'chat-new')
assert.equal(useAppStore.getState().selectedSurfaceId, null)

// Closing removes locally first and clears its selection.
useAppStore.getState().selectSurface('term_1')
await useAppStore.getState().removeSurface('term_1')
assert.deepEqual(calls.at(-1), ['delete', 'term_1'])
assert.equal(useAppStore.getState().surfaces.some(item => item.id === 'term_1'), false)
assert.equal(useAppStore.getState().selectedSurfaceId, null)

// A server without the tabs route leaves the list alone and raises no error.
stored = useAppStore.getState().surfaces
client.listSurfaces = async () => { throw new Error('Not Found') }
await useAppStore.getState().refreshSurfaces()
assert.deepEqual(useAppStore.getState().surfaces, stored)
assert.equal(useAppStore.getState().error, null)

// Another server's tabs are not this one's: switching profiles starts with none.
useAppStore.getState().selectSurface('browser_1')
assert.equal(await useAppStore.getState().switchServerProfile('other'), true)
assert.deepEqual(useAppStore.getState().surfaces, [])
assert.equal(useAppStore.getState().selectedSurfaceId, null)

console.log('useAppStore surfaces ok')
