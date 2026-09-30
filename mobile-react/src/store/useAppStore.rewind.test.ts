import assert from 'node:assert/strict'
import * as Notifications from 'expo-notifications'
import { AppState as NativeAppState } from 'react-native'
import { SNAPSHOT_CACHE_VERSION } from '../lib/history'
import type { Event, FilesPage, Health, Session, Snapshot, TimelinePage } from '../types'
import { client, useAppStore } from './useAppStore'

const timestamp = '2026-09-28T12:00:00.000Z'
const session = (id: string): Session => ({
  id,
  title: `Title ${id}`,
  backend: 'codex',
  archived: false,
  created_at: timestamp,
  updated_at: timestamp,
  latest_event_seq: 5,
  latest_agent_event_seq: 5,
  last_read_agent_event_seq: 5,
  manual_unread: false,
})
const sessionA = session('chat-a')
const sessionB = session('chat-b')
const event = (seq: number, type: string, extra: Partial<Event> = {}): Event => ({
  id: `event-${seq}`, seq, session_id: sessionA.id, type, ts: timestamp, ...extra,
})
const initialEvents = [
  event(1, 'turn_started', { run_id: 'run-1', prompt: 'First' }),
  event(2, 'turn_finished', { run_id: 'run-1', result_text: 'One' }),
  event(3, 'turn_started', { run_id: 'run-2', prompt: 'Second' }),
  event(4, 'assistant_text', { run_id: 'run-2', text: 'Two' }),
  event(5, 'turn_finished', { run_id: 'run-2', result_text: 'Two' }),
]
const snapshot = (value: Session): Snapshot => ({
  cacheVersion: SNAPSHOT_CACHE_VERSION,
  session: value,
  events: value.id === sessionA.id ? initialEvents : [],
  queuedTurns: [],
  files: [],
  filesTotal: 0,
  hasMore: false,
  total: value.id === sessionA.id ? 5 : 0,
  latestSeq: 5,
  nextBefore: null,
  semanticPaging: null,
  cachedAt: Date.now(),
})
const page = (value: Session): TimelinePage => ({
  session: value,
  events: value.id === sessionA.id ? initialEvents : [],
  queued_turns: [],
  has_more: false,
  before: null,
  next_before: null,
  total: value.id === sessionA.id ? 5 : 0,
  latest_seq: 5,
  events_omitted_before: 0,
  events_omitted_after: 0,
  semantic_item_count: null,
  semantic_total: null,
  semantic_omitted_before: null,
  semantic_omitted_after: null,
  next_semantic_before: null,
  semantic_paging: null,
})
let health: Health = { ok: true, server_identity: 'uninitialized', api_contract_version: 8, active: [] }

const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }
const notifications = Notifications as typeof Notifications & { __scheduledNotifications(): Array<{ title?: string; body?: string }> }
const originalSessionPage = client.sessionPage.bind(client)
const originalFiles = client.files.bind(client)
const originalStream = client.stream.bind(client)
const originalHealth = client.health.bind(client)
const originalSessions = client.sessions.bind(client)
let emit: ((event: Event) => void) | null = null

client.markValidated()
client.sessionPage = async sessionId => page(sessionId === sessionB.id ? sessionB : sessionA)
client.files = async (): Promise<FilesPage> => ({ files: [], total: 0, offset: 0, limit: 60, has_more: false })
client.stream = (_sessionId, _after, onEvent, onState) => {
  emit = onEvent
  onState(true)
  return () => { emit = null }
}
client.health = async () => health
client.sessions = async () => [sessionA, sessionB]

try {
  appState.__emitAppState('active')
  useAppStore.setState({
    initialized: true,
    activeProfileId: 'uninitialized',
    profiles: [{
      id: 'uninitialized', name: 'Test hub', serverURL: 'http://127.0.0.1:7850', serverIdentity: 'uninitialized', serverConfigured: true,
      credentialVersion: 1, createdAt: timestamp, updatedAt: timestamp,
      hasAccessToken: false, connectionState: 'online', cachedUnreadCount: 0,
    }],
    profileGeneration: 0,
    serverConfigured: true,
    connected: true,
    connecting: false,
    workspaceAdopting: false,
    health,
    sessions: [sessionA, sessionB],
    selectedSessionId: sessionA.id,
    snapshots: { [sessionA.id]: snapshot(sessionA), [sessionB.id]: snapshot(sessionB) },
    activeSessionIds: new Set(),
    syncSessionId: sessionA.id,
    syncStatus: 'cached',
    syncError: null,
    liveConnected: false,
    error: null,
  })
  await useAppStore.getState().selectSession(sessionA.id)
  assert.ok(emit, 'selecting a chat must open its live stream')
  const live = emit as (event: Event) => void

  // A history_rewound tombstone drops its closed range before it is appended.
  live(event(6, 'history_rewound', { from_seq: 3, through_seq: 5, to_run_id: 'run-2', removed_events: 3, provider_rewind: 'codex_fork' }))
  const rewound = useAppStore.getState().snapshots[sessionA.id]!
  assert.deepEqual(rewound.events.map(value => value.seq), [1, 2, 6], 'events inside [from_seq, through_seq] are pruned and the tombstone is kept')
  assert.equal(rewound.latestSeq, 6, 'the tombstone advances the known tail')
  assert.equal(rewound.total, 2, 'the server total shrinks by the removed events (live appends never adjust it)')

  // Notifications: one per finished turn, only for live terminal events.
  const scheduled = notifications.__scheduledNotifications()
  const before = scheduled.length
  appState.__emitAppState('background')
  live(event(7, 'assistant_text', { run_id: 'run-3', text: 'Streaming' }))
  assert.equal(scheduled.length, before, 'assistant text never notifies')
  live(event(8, 'turn_finished', { run_id: 'run-3', result_text: 'Three' }))
  live(event(8, 'turn_finished', { run_id: 'run-3', result_text: 'Three' }))
  live(event(9, 'turn_stopped', { run_id: 'run-3' }))
  assert.equal(scheduled.length, before + 1, 'redelivered or repeated terminals of one run notify once')
  assert.deepEqual(scheduled.at(-1), { title: sessionA.title, body: 'Response finished' })
  live(event(10, 'turn_finished', { run_id: 'import_x', result_text: 'Replayed', imported: true }))
  assert.equal(scheduled.length, before + 1, 'imported terminals are replayed history, not a finished turn')
  live(event(11, 'turn_finished', { run_id: 'run-4', result_text: 'Four' }))
  assert.equal(scheduled.length, before + 2, 'a different run notifies again')

  // A chat that is not on screen notifies when the health poll drops it from `active`.
  appState.__emitAppState('active')
  useAppStore.setState(state => ({ activeSessionIds: new Set([...state.activeSessionIds, sessionB.id]) }))
  health = { ...health, active: [] }
  await useAppStore.getState().refreshSessions()
  assert.equal(scheduled.length, before + 3, 'a background chat leaving the active set notifies once')
  assert.deepEqual(scheduled.at(-1), { title: sessionB.title, body: 'Response finished' })
  await useAppStore.getState().refreshSessions()
  assert.equal(scheduled.length, before + 3, 'an unchanged idle set does not notify again')

  // Editing an earlier turn seeds the composer and restores the previous draft on cancel.
  useAppStore.getState().setSessionDraft(sessionA.id, 'half typed')
  useAppStore.getState().beginEditingTurn(sessionA.id, 'run-1', 'First')
  assert.deepEqual(useAppStore.getState().editingTurn[sessionA.id], { runId: 'run-1', seq: undefined, previousDraft: 'half typed' })
  assert.equal(useAppStore.getState().drafts[sessionA.id], 'First')
  useAppStore.getState().cancelEditingTurn(sessionA.id)
  assert.equal(useAppStore.getState().editingTurn[sessionA.id], null)
  assert.equal(useAppStore.getState().drafts[sessionA.id], 'half typed')

  // Rewind is refused without the capability, and does not touch the server.
  let rewindCalls = 0
  client.rewindSession = async () => { rewindCalls += 1; throw new Error('unexpected') }
  assert.equal(await useAppStore.getState().rewindSession(sessionA.id, 'run-1'), false)
  assert.match(useAppStore.getState().error ?? '', /Update AgentsServer/)
  assert.equal(rewindCalls, 0)

  // With the capability, a busy chat is refused; an idle chat prunes from the response.
  useAppStore.setState({
    health: { ...health, capabilities: { session_rewind_v1: { available: true, version: 1, supported_backends: ['codex'], checkpoint_restore: true } } },
    error: null,
  })
  useAppStore.setState(state => ({ activeSessionIds: new Set([...state.activeSessionIds, sessionA.id]) }))
  assert.equal(await useAppStore.getState().rewindSession(sessionA.id, 'run-1'), false)
  assert.match(useAppStore.getState().error ?? '', /Wait for the current turn/)
  assert.equal(rewindCalls, 0)
  useAppStore.setState(state => {
    const active = new Set(state.activeSessionIds)
    active.delete(sessionA.id)
    return { activeSessionIds: active, error: null }
  })
  let expectedLatestSeq = -1
  client.rewindSession = async (_sessionId, _runId, latestSeq) => {
    rewindCalls += 1
    expectedLatestSeq = latestSeq
    return { ok: true, from_seq: 2, through_seq: 11, removed_events: 5, provider_rewind: 'codex_fork', session: sessionA }
  }
  useAppStore.getState().beginEditingTurn(sessionA.id, 'run-1', 'First edited')
  assert.equal(await useAppStore.getState().rewindSession(sessionA.id, 'run-1'), true)
  assert.equal(rewindCalls, 1)
  assert.equal(expectedLatestSeq, 11, 'the guard is the highest event seq received for the chat')
  assert.deepEqual(useAppStore.getState().snapshots[sessionA.id]!.events.map(value => value.seq), [1], 'the response range is pruned locally')
  assert.equal(useAppStore.getState().editingTurn[sessionA.id], null, 'a successful rewind ends the edit')

  // Checkpoint restore reads the workspace revision, restores, then rewinds.
  const calls: string[] = []
  client.workspaceGitStatus = async () => { calls.push('status'); return { root: '/', branch: 'main', head: 'abc', revision: 'rev-1' } }
  client.restoreCheckpoint = async (_sessionId, runId, expectedRevision) => { calls.push(`restore:${runId}:${expectedRevision}`); return { root: '/', branch: 'main', head: 'def', revision: 'rev-2' } }
  client.rewindSession = async (_sessionId, runId) => { calls.push(`rewind:${runId}`); return { ok: true, from_seq: 2, through_seq: 2, removed_events: 0, provider_rewind: 'codex_reset', session: sessionA } }
  assert.equal(await useAppStore.getState().restoreCheckpoint(sessionA.id, 'run-1'), true)
  assert.deepEqual(calls, ['status', 'restore:run-1:rev-1', 'rewind:run-1'])

  console.log('store rewind and notification regressions passed')
} finally {
  appState.__emitAppState('background')
  client.sessionPage = originalSessionPage
  client.files = originalFiles
  client.stream = originalStream
  client.health = originalHealth
  client.sessions = originalSessions
  appState.__emitAppState('active')
}
