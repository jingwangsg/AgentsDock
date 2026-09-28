import assert from 'node:assert/strict'
import { AppState as NativeAppState } from 'react-native'
import { SNAPSHOT_CACHE_VERSION } from '../lib/history'
import type { Event, FilesPage, Health, Session, Snapshot, SubagentSnapshot, TimelinePage } from '../types'
import { client, useAppStore } from './useAppStore'

const timestamp = '2026-09-28T12:00:00.000Z'
const session = (id: string): Session => ({
  id,
  title: `Title ${id}`,
  backend: 'claude',
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
const health: Health = { ok: true, server_identity: 'uninitialized', api_contract_version: 8, active: [] }

const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }
let emit: ((event: Event) => void) | null = null
const subagentCalls: string[] = []
let subagentRecords: Event[] = []
// While set, subagent requests stay pending so overlapping polls can be observed.
let gate: Promise<void> | null = null
let openGate: () => void = () => {}

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
client.markRead = async () => sessionA
client.subagents = async (sessionId): Promise<SubagentSnapshot> => {
  subagentCalls.push(sessionId)
  if (gate) await gate
  const subagents = subagentRecords.filter(record => record.session_id === sessionId)
  return { session_id: sessionId, subagents, count: subagents.length, active_count: 0, latest_seq: subagents.at(-1)?.seq ?? null }
}

const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const intervals = new Map<number, { delay: number; tick: () => void }>()
let nextInterval = 700_000
globalThis.setInterval = ((handler: TimerHandler, delay?: number) => {
  const id = nextInterval++
  intervals.set(id, { delay: delay ?? 0, tick: typeof handler === 'function' ? () => { handler() } : () => {} })
  return id as unknown as ReturnType<typeof setInterval>
}) as unknown as typeof setInterval
globalThis.clearInterval = ((id?: unknown) => { intervals.delete(id as number) }) as typeof clearInterval
const polls = () => [...intervals.values()].filter(timer => timer.delay === 5_000)
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

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
    subagentsBySession: {},
    syncSessionId: sessionA.id,
    syncStatus: 'cached',
    syncError: null,
    liveConnected: false,
    error: null,
  })

  // Opening a chat fetches its snapshot once; an idle chat is not polled.
  await useAppStore.getState().selectSession(sessionA.id)
  await flush()
  assert.deepEqual(subagentCalls, [sessionA.id], 'opening a chat fetches its subagent snapshot')
  assert.equal(polls().length, 0, 'an idle chat has no subagent poll')
  assert.ok(emit, 'selecting a chat must open its live stream')
  const live = emit as (event: Event) => void

  // Streamed state lands in the slice, never in the timeline.
  live(event(6, 'subagent_state', { run_id: 'run-1', subagent_id: 'child-1', subagent_status: 'running', subagent_name: 'Audit the renderer' }))
  let slice = useAppStore.getState().subagentsBySession[sessionA.id]
  assert.equal(slice?.['child-1']?.seq, 6, 'a streamed subagent_state is stored by subagent id')
  assert.equal(useAppStore.getState().snapshots[sessionA.id]!.events.some(value => value.type === 'subagent_state'), false, 'subagent_state never becomes a timeline event')
  live(event(4, 'subagent_state', { run_id: 'run-1', subagent_id: 'child-1', subagent_status: 'starting' }))
  assert.equal(useAppStore.getState().subagentsBySession[sessionA.id], slice, 'an older record for the same id leaves the slice reference untouched')

  // A running turn starts the 5 s poll; ticks fetch; a pending request is never overlapped.
  live(event(7, 'turn_started', { run_id: 'run-1' }))
  assert.ok(useAppStore.getState().activeSessionIds.has(sessionA.id))
  assert.equal(polls().length, 1, 'an active open chat is polled')
  polls()[0].tick()
  await flush()
  assert.equal(subagentCalls.length, 2, 'a poll tick fetches the snapshot')
  gate = new Promise<void>(resolve => { openGate = resolve })
  polls()[0].tick()
  polls()[0].tick()
  await flush()
  assert.equal(subagentCalls.length, 3, 'ticks while a request is pending do not start another')
  openGate()
  gate = null
  await flush()

  // Snapshot records merge by seq: newer wins, an older server record never regresses a streamed one.
  subagentRecords = [
    event(9, 'subagent_state', { run_id: 'run-1', subagent_id: 'child-1', subagent_status: 'completed' }),
    event(8, 'subagent_state', { run_id: 'run-1', subagent_id: 'child-2', subagent_status: 'running' }),
  ]
  polls()[0].tick()
  await flush()
  slice = useAppStore.getState().subagentsBySession[sessionA.id]
  assert.equal(slice?.['child-1']?.subagent_status, 'completed')
  assert.equal(slice?.['child-2']?.seq, 8)
  subagentRecords = [event(3, 'subagent_state', { run_id: 'run-1', subagent_id: 'child-1', subagent_status: 'running' })]
  polls()[0].tick()
  await flush()
  assert.equal(useAppStore.getState().subagentsBySession[sessionA.id], slice, 'a stale snapshot record keeps the newer state and the reference')

  // The turn's end stops the poll and fetches once more so final statuses land.
  const callsBeforeEnd = subagentCalls.length
  live(event(10, 'turn_finished', { run_id: 'run-1' }))
  await flush()
  assert.equal(polls().length, 0, 'the poll stops when the chat leaves the active set')
  assert.equal(subagentCalls.length, callsBeforeEnd + 1, 'turn end fetches the snapshot once')

  // A rewind drops the chat's records and refetches.
  subagentRecords = []
  const callsBeforeRewind = subagentCalls.length
  live(event(11, 'history_rewound', { from_seq: 6, through_seq: 10, to_run_id: 'run-0', removed_events: 5 }))
  await flush()
  assert.equal(subagentCalls.length, callsBeforeRewind + 1, 'history_rewound refetches the snapshot')
  assert.equal(useAppStore.getState().subagentsBySession[sessionA.id], undefined, 'history_rewound clears the rewound chat\'s records')

  // Switching chats stops the previous chat's poll and fetches the new chat once.
  live(event(12, 'turn_started', { run_id: 'run-2' }))
  assert.equal(polls().length, 1)
  await useAppStore.getState().selectSession(sessionB.id)
  await flush()
  assert.equal(polls().length, 0, 'the poll follows the open chat; chat-b is idle')
  assert.equal(subagentCalls.at(-1), sessionB.id, 'opening the other chat fetches its snapshot')
} finally {
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
}

console.log('subagent store regressions passed')
