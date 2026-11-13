import assert from 'node:assert/strict'
import test from 'node:test'
import { AppState as NativeAppState } from 'react-native'
import { loadWorkspacePreferences } from '../storage/cache'
import type { Health, PublicServerProfile, Session, Surface } from '../types'
import { client, useAppStore } from './useAppStore'

// A server with folder_order_v1 keeps one chat-list folder order for every device: the app shows it, sends its own
// changes, and follows another device's from a pushed packet or, when the socket dropped, the health revision. An older
// server leaves the app its own order, as before. The cases run in order on one store.

const timestamp = '2026-11-13T00:00:00.000Z'
const chat = (id: string, folder: string): Session => ({
  id, title: id, backend: 'codex', folder, archived: false, created_at: timestamp, updated_at: timestamp,
  latest_event_seq: 1, latest_agent_event_seq: 1, last_read_agent_event_seq: 1, manual_unread: false,
})
const profile = (id: string, serverURL: string, serverIdentity: string): PublicServerProfile => ({
  id, name: id, serverURL, serverIdentity, serverConfigured: true,
  credentialVersion: 1, createdAt: timestamp, updatedAt: timestamp,
  hasAccessToken: false, connectionState: 'online', cachedUnreadCount: 0,
})
const tab: Surface = { id: 'term_1', kind: 'terminal', name: null, folder: 'Tabs', cwd: null, url: null, page_title: null, created_at: timestamp, updated_at: timestamp }
const olderServer: Health = { ok: true, server_identity: 'uninitialized', api_contract_version: 8, active: [] }
const sharedOrder = { folder_order_v1: { available: true, version: 1, path: '/api/folders/order', stream_protocol: 'agentsdock-session-summaries-v2' } }
let health = olderServer
const chats = [chat('zeta', 'Zeta'), chat('work', 'Work'), chat('general', 'General')]
// The server's side of GET/PUT /api/folders/order.
let kept: { order: string[] | null; revision: number } = { order: null, revision: 100 }
let refusal: Error | null = null
const requests: Array<['GET'] | ['PUT', string[]]> = []
let stream: Parameters<typeof client.sessionSummaryStream>[0] | null = null
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const state = () => useAppStore.getState()
const savedOrder = async () => (await loadWorkspacePreferences('profile:uninitialized')).folderOrder

client.markValidated()
client.health = async () => health
client.sessions = async () => chats
client.folderOrder = async () => { requests.push(['GET']); return kept }
client.putFolderOrder = async order => {
  requests.push(['PUT', order])
  if (refusal) throw refusal
  kept = { order, revision: kept.revision + 1 }
  return { order, revision: kept.revision }
}
client.sessionSummaryStream = handlers => { stream = handlers; return () => { stream = null } }
globalThis.fetch = async () => { throw new Error('Unexpected network request in folder order regression') }

;(NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }).__emitAppState('active')
useAppStore.setState({
  initialized: true,
  activeProfileId: 'uninitialized',
  profiles: [profile('uninitialized', 'http://127.0.0.1:7850', 'uninitialized'), profile('other', 'https://other.example', 'identity-other')],
  profileGeneration: 0,
  serverConfigured: true,
  connected: true,
  connecting: false,
  workspaceAdopting: false,
  switchingProfileId: null,
  health,
  sessions: chats,
  surfaces: [tab],
  selectedSessionId: null,
  folderOrder: ['Work'],
  error: null,
})

await test('an older server leaves the order to this app: folders seen in chats join it, and nothing is read or sent', async () => {
  assert.deepEqual(state().folderOrder, ['Work', 'Zeta', 'General'])
  assert.equal(await state().setFolderOrder(['General', 'Work', 'Zeta']), true)
  assert.deepEqual(state().folderOrder, ['General', 'Work', 'Zeta'])
  useAppStore.setState({ sessions: [...chats, chat('notes', 'Notes')] })
  assert.deepEqual(state().folderOrder, ['General', 'Work', 'Zeta', 'Notes'])
  await state().refreshSessions()
  await settle()
  assert.deepEqual(requests, [])
})

await test('a server without an order yet takes this app\'s, as its sidebar shows it', async () => {
  // The stored order, then the chat folders it lacks alphabetically, then folders holding only tabs.
  health = { ...olderServer, capabilities: sharedOrder, folder_order_revision: 100 }
  useAppStore.setState({ health, sessions: chats, folderOrder: ['Work'] })
  await state().refreshSessions()
  await settle()
  assert.deepEqual(requests, [['GET'], ['PUT', ['Work', 'General', 'Zeta', 'Tabs']]])
  assert.deepEqual(state().folderOrder, ['Work', 'General', 'Zeta', 'Tabs'])
  assert.equal(state().folderOrderRevision, 101)
  assert.deepEqual(await savedOrder(), ['Work', 'General', 'Zeta', 'Tabs'])
})

await test('at connect the server\'s order replaces the cached one as it is, and is saved for the next cold start', async () => {
  // Launch, a server switch and an identity adoption all connect with no revision shown.
  kept = { order: ['Zeta', 'Work'], revision: 150 }
  health = { ...health, folder_order_revision: 150 }
  const read = requests.length
  useAppStore.setState({ connected: false, folderOrderRevision: null })
  await state().reconnect()
  await settle()
  assert.equal(state().connected, true)
  assert.deepEqual(requests.slice(read), [['GET']])
  assert.deepEqual(state().folderOrder, ['Zeta', 'Work'], 'folders seen in chats are not added to the server\'s order')
  assert.equal(state().folderOrderRevision, 150)
  assert.deepEqual(await savedOrder(), ['Zeta', 'Work'])
})

await test('a change shows at once, is sent whole and the answer kept; a refused one reports why and leaves the server\'s order', async () => {
  const reordering = state().setFolderOrder(['Work', 'General', 'Zeta'])
  assert.deepEqual(state().folderOrder, ['Work', 'General', 'Zeta'], 'the change shows before the server answers')
  assert.equal(await reordering, true)
  assert.deepEqual(requests.at(-1), ['PUT', ['Work', 'General', 'Zeta']])
  assert.equal(state().folderOrderRevision, 151)

  refusal = new Error('Could not save the folder order.')
  assert.equal(await state().setFolderOrder(['Zeta', 'General', 'Work']), false)
  assert.deepEqual(state().folderOrder, ['Work', 'General', 'Zeta'])
  assert.equal(state().error, 'Could not save the folder order.')
  refusal = null
  useAppStore.setState({ error: null })
})

await test('another device\'s change arrives on the summary stream; an older revision or another server\'s packet is ignored', async () => {
  assert.ok(stream, 'the summary stream is open')
  stream.onFolderOrder({ server_identity: 'uninitialized', order: ['General', 'Work', 'Zeta'], revision: 160 })
  assert.deepEqual(state().folderOrder, ['General', 'Work', 'Zeta'])
  stream.onFolderOrder({ server_identity: 'uninitialized', order: ['Work'], revision: 155 })
  stream.onFolderOrder({ server_identity: 'identity-other', order: ['Elsewhere'], revision: 170 })
  assert.deepEqual(state().folderOrder, ['General', 'Work', 'Zeta'])
  assert.equal(state().folderOrderRevision, 160)
  await settle()
  assert.deepEqual(await savedOrder(), ['General', 'Work', 'Zeta'])
})

await test('the server, not this app, adds a chat\'s new folder to the order', async () => {
  const sent = requests.length
  useAppStore.setState({ sessions: [...state().sessions, chat('lab', 'Lab')] })
  await settle()
  assert.deepEqual(state().folderOrder, ['General', 'Work', 'Zeta'])
  assert.equal(requests.length, sent)
})

await test('a change a dropped socket missed shows at the next chat-list refresh, read only when the health revision moved', async () => {
  kept = { order: ['Lab', 'General', 'Work', 'Zeta'], revision: 180 }
  health = { ...health, folder_order_revision: 180 }
  const read = requests.length
  await state().refreshSessions()
  await settle()
  assert.deepEqual(requests.slice(read), [['GET']])
  assert.deepEqual(state().folderOrder, ['Lab', 'General', 'Work', 'Zeta'])
  await state().refreshSessions()
  await settle()
  assert.equal(requests.length, read + 1)
})

await test('after a server switch the next server\'s order is taken whatever its revision', async () => {
  assert.equal(state().folderOrderRevision, 180)
  assert.equal(await state().switchServerProfile('other'), true)
  assert.equal(state().folderOrderRevision, null)
})
