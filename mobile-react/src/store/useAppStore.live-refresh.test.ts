import assert from 'node:assert/strict'
import { AppState as NativeAppState } from 'react-native'
import { SNAPSHOT_CACHE_VERSION } from '../lib/history'
import type { Event, FilesPage, Health, Session, Snapshot, TimelinePage } from '../types'
import { client, useAppStore } from './useAppStore'

// A live event already carries latest_event_*; the fields it does not carry
// (title, pending interactions, backend lock) come from one row fetch per quiet
// burst instead of a whole-list refresh per event.

const timestamp = '2026-07-31T12:00:00.000Z'
const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id,
  title: id,
  backend: 'codex',
  archived: false,
  created_at: timestamp,
  updated_at: timestamp,
  latest_event_seq: 5,
  latest_agent_event_seq: 5,
  last_read_agent_event_seq: 5,
  manual_unread: false,
  ...patch,
})
const snapshot = (value: Session): Snapshot => ({
  cacheVersion: SNAPSHOT_CACHE_VERSION,
  session: value,
  events: [],
  queuedTurns: [],
  files: [],
  filesTotal: 0,
  hasMore: false,
  total: 0,
  latestSeq: 5,
  nextBefore: null,
  semanticPaging: null,
  cachedAt: Date.now(),
})
const page = (value: Session): TimelinePage => ({
  session: value,
  events: [],
  queued_turns: [],
  has_more: false,
  before: null,
  next_before: null,
  total: 0,
  latest_seq: value.latest_event_seq ?? 5,
  events_omitted_before: 0,
  events_omitted_after: 0,
  semantic_item_count: null,
  semantic_total: null,
  semantic_omitted_before: null,
  semantic_omitted_after: null,
  next_semantic_before: null,
  semantic_paging: null,
})
const event = (seq: number, type: string): Event => ({ id: `event-${seq}`, session_id: sessionA.id, seq, type, ts: timestamp })
// The store coalesces for 500 ms; wait past that plus the fetch microtasks.
const settleBurst = () => new Promise(resolve => setTimeout(resolve, 700))

const sessionA = session('chat-a')
const sessionB = session('chat-b')
const health: Health = { ok: true, server_identity: 'uninitialized', api_contract_version: 8 }
const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }
const originalHealth = client.health.bind(client)
const originalSessions = client.sessions.bind(client)
const originalJobs = client.jobs.bind(client)
const originalSessionPage = client.sessionPage.bind(client)
const originalFiles = client.files.bind(client)
const originalStream = client.stream.bind(client)
const originalSubagents = client.subagents.bind(client)
let listFetches = 0
let jobsFetches = 0
const pageCalls: Array<{ sessionId: string; options: Parameters<typeof client.sessionPage>[1] }> = []
let serverRow: Session = sessionA
let emit: ((event: Event) => void) | null = null

client.markValidated()
client.health = async () => health
client.sessions = async () => { listFetches += 1; return [serverRow, sessionB] }
client.jobs = async () => { jobsFetches += 1; return [] }
client.subagents = async sessionId => ({ session_id: sessionId, subagents: [], count: 0, active_count: 0, latest_seq: null })
client.files = async (): Promise<FilesPage> => ({ files: [], total: 0, offset: 0, limit: 60, has_more: false })
client.sessionPage = async (sessionId, options) => {
  pageCalls.push({ sessionId, options })
  return page(sessionId === sessionA.id ? serverRow : sessionB)
}
client.stream = (_sessionId, _after, onEvent, onState) => {
  emit = onEvent
  onState(true)
  return () => { emit = null }
}

try {
  appState.__emitAppState('active')
  useAppStore.setState({
    initialized: true,
    activeProfileId: 'uninitialized',
    profileGeneration: 0,
    serverConfigured: true,
    connected: true,
    connecting: false,
    workspaceAdopting: false,
    health,
    sessions: [sessionA, sessionB],
    selectedSessionId: null,
    snapshots: { [sessionA.id]: snapshot(sessionA), [sessionB.id]: snapshot(sessionB) },
    jobs: [],
    error: null,
  })
  await useAppStore.getState().selectSession(sessionA.id)
  assert.ok(emit, 'selecting a chat must open its live stream')
  const pageCallsAfterSelect = pageCalls.length
  const listFetchesAfterSelect = listFetches
  // The turn's title and first-turn lock are written server-side; no event carries them.
  serverRow = session(sessionA.id, { title: 'Titled by the server', backend_locked: true, latest_event_seq: 7, latest_agent_event_seq: 7 })

  emit!(event(6, 'turn_finished'))
  emit!(event(7, 'artifact_created'))
  assert.equal(useAppStore.getState().sessions[0]?.latest_event_seq, 7, 'the event itself updates the row metadata synchronously')
  assert.equal(useAppStore.getState().sessions[0]?.title, sessionA.id, 'the row is not rewritten before the server is asked')
  await settleBurst()

  assert.equal(listFetches, listFetchesAfterSelect, 'a live event must not re-fetch the whole chat list')
  const rowFetches = pageCalls.slice(pageCallsAfterSelect)
  assert.equal(rowFetches.length, 1, 'two triggering events inside one burst must coalesce into one row fetch')
  assert.equal(rowFetches[0]!.sessionId, sessionA.id)
  assert.equal(rowFetches[0]!.options?.limit, 1, 'the row fetch asks for at most one event')
  assert.equal(rowFetches[0]!.options?.tail, false)
  assert.equal(rowFetches[0]!.options?.after, 7, 'the row fetch pages after the newest event the stream delivered')
  const row = useAppStore.getState().sessions.find(value => value.id === sessionA.id)
  assert.equal(row?.title, 'Titled by the server', 'server-side fields the event does not carry land in the list row')
  assert.equal(row?.backend_locked, true)
  assert.equal(useAppStore.getState().sessions[1], sessionB, 'rows of other chats keep their identity')

  const jobsFetchesBefore = jobsFetches
  emit!(event(8, 'job_updated'))
  emit!(event(9, 'job_updated'))
  emit!(event(10, 'job_deleted'))
  await settleBurst()
  assert.equal(jobsFetches, jobsFetchesBefore + 1, 'a burst of job events re-reads the jobs list once')

  // A stale scope at fire time must not write into the new connection's state.
  const pageCallsBeforeSwitch = pageCalls.length
  emit!(event(11, 'turn_finished'))
  useAppStore.setState({ connected: false })
  await settleBurst()
  assert.equal(pageCalls.length, pageCallsBeforeSwitch, 'a disconnected store must not issue the deferred row fetch')

  console.log('live event row refresh regressions passed')
} finally {
  appState.__emitAppState('background')
  await useAppStore.getState().selectSession(sessionA.id)
  client.health = originalHealth
  client.sessions = originalSessions
  client.jobs = originalJobs
  client.sessionPage = originalSessionPage
  client.files = originalFiles
  client.stream = originalStream
  client.subagents = originalSubagents
  appState.__emitAppState('active')
}
