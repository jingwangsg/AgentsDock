import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as Notifications from 'expo-notifications'
import { AppState as NativeAppState } from 'react-native'
import { SNAPSHOT_CACHE_VERSION } from '../lib/history'
import { isUnread } from '../lib/format'
import type { Event, Session, Snapshot, StoredProfileSettings } from '../types'

// The chats nobody has open are kept warm in the background: only those with a timeline on this device, newest first,
// a small page at a time, one request in flight, paced, never while the user's own sync runs or the app is away, and
// without marking anything read. Every request is logged with its timing.
const timestamp = '2026-11-03T08:00:00.000Z'
const at = (minute: number) => `2026-11-03T08:${String(minute).padStart(2, '0')}:00.000Z`
// The server's chats: the newest sequence of each (all rows visible) and when it last changed.
const chats: Record<string, { latest: number; minute: number; extra?: Partial<Session> }> = {
  open: { latest: 20, minute: 59 },
  // Its pages fail: read once, then left alone until it changes, while the others are warmed.
  broken: { latest: 30, minute: 58 },
  unread: { latest: 15, minute: 57, extra: { latest_agent_event_seq: 15, last_read_agent_event_seq: 10 } },
  busy: { latest: 70, minute: 56 },
  long: { latest: 400, minute: 55 },
  fresh: { latest: 30, minute: 54 },
  current: { latest: 12, minute: 53 },
  later: { latest: 5, minute: 50 },
  archived: { latest: 9, minute: 53, extra: { archived: true } },
  'job-run': { latest: 9, minute: 52, extra: { scheduled_job_run: { job_id: 'job-1', session_id: 'busy' } } },
}
const sessionOf = (id: string): Session => ({
  id, title: id, backend: 'claude', archived: false, created_at: timestamp, updated_at: timestamp,
  latest_event_seq: chats[id].latest, latest_event_at: at(chats[id].minute),
  latest_agent_event_seq: chats[id].latest, last_read_agent_event_seq: chats[id].latest, manual_unread: false,
  ...chats[id].extra,
})
const eventOf = (id: string, seq: number): Event => ({ id: `${id}-${seq}`, seq, session_id: id, type: 'assistant_text', text: `row ${seq}`, ts: timestamp } as Event)

const log: Array<{ path: string; query: URLSearchParams; start: number; end: number }> = []
let inFlightPrefetch = 0
let maxInFlightPrefetch = 0
let holdOpenPage: Promise<void> | null = null
// A server before session_prefetch_v1 is never warmed.
let prefetchCapable = false

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const entry = { path: `${request.method} ${url.pathname}`, query: url.searchParams, start: Date.now(), end: 0 }
  log.push(entry)
  const prefetch = url.searchParams.get('prefetch') === 'true'
  if (prefetch) maxInFlightPrefetch = Math.max(maxInFlightPrefetch, ++inFlightPrefetch)
  const reply = (status: number, value: unknown) => {
    const body = JSON.stringify(value)
    entry.end = Date.now()
    if (prefetch) inFlightPrefetch -= 1
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) })
    response.end(body)
  }
  if (request.headers['x-zenithdock-token'] !== 'token-a' && request.headers['x-agentsdock-token'] !== 'token-a') return reply(401, { detail: 'unauthorized' })
  if (url.pathname === '/api/health') {
    return reply(200, { ok: true, server_identity: 'server-a', server_instance_id: 'a-1', api_contract_version: 8, active: [],
      capabilities: prefetchCapable ? { session_prefetch_v1: { available: true, version: 1 } } : {} })
  }
  if (url.pathname === '/api/sessions') return reply(200, { sessions: Object.keys(chats).map(sessionOf) })
  if (url.pathname === '/api/runtime/catalog') return reply(200, { backends: {} })
  if (url.pathname === '/api/jobs') return reply(200, { jobs: [] })
  const page = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
  if (page && request.method === 'GET') {
    const id = decodeURIComponent(page[1])
    const latest = chats[id].latest
    const after = Number(url.searchParams.get('after') ?? 0)
    const limit = Number(url.searchParams.get('limit') ?? 240)
    const tail = url.searchParams.get('tail') !== 'false' && after <= 0
    const rest = Array.from({ length: latest }, (_, index) => index + 1).filter(seq => tail || seq > after)
    const seqs = tail ? rest.slice(-limit) : rest.slice(0, limit)
    const answer = () => reply(200, {
      session: sessionOf(id), events: seqs.map(seq => eventOf(id, seq)), queued_turns: [],
      events_omitted_before: tail ? latest - seqs.length : 0, events_omitted_after: tail ? 0 : rest.length - seqs.length,
      latest_seq: latest, event_count: latest,
    })
    if (id === 'open' && holdOpenPage) return void holdOpenPage.then(answer)
    if (id === 'broken') return reply(500, { detail: 'history unreadable' })
    return answer()
  }
  reply(404, { detail: 'not found' })
})

const snapshotOf = (id: string, latest: number): Snapshot => ({
  cacheVersion: SNAPSHOT_CACHE_VERSION, session: sessionOf(id),
  events: Array.from({ length: latest }, (_, index) => eventOf(id, index + 1)),
  queuedTurns: [], files: [], filesTotal: 0, hasMore: false, total: latest, latestSeq: latest, nextBefore: null, semanticPaging: null, cachedAt: Date.now(),
})
const prefetches = (since = 0) => log.slice(since).filter(entry => entry.query.get('prefetch') === 'true')
const chatOf = (entry: { path: string }) => decodeURIComponent(entry.path.split('/').at(-1)!)

async function waitFor(condition: () => boolean, message: string, timeoutMs = 20_000): Promise<void> {
  for (const started = Date.now(); Date.now() - started < timeoutMs;) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}

const originalSetInterval = globalThis.setInterval
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const serverURL = `http://127.0.0.1:${address.port}`
  ;(globalThis as { expo?: { uuidv4: () => string } }).expo = { uuidv4: () => crypto.randomUUID() }
  await AsyncStorage.clear()
  ;(SecureStore as typeof SecureStore & { __resetSecureStore(): void }).__resetSecureStore()
  ;(Notifications as typeof Notifications & { __resetNotifications(): void }).__resetNotifications()
  const settings: StoredProfileSettings = {
    schemaVersion: 2,
    activeProfileId: 'mac',
    profiles: [{ id: 'mac', name: 'Mac', serverURL, serverIdentity: 'server-a', serverConfigured: true, credentialVersion: 1, createdAt: timestamp, updatedAt: timestamp }],
    fontScale: 1,
    appearance: 'dark',
  }
  await AsyncStorage.setItem('agentsdock.react.settings.v2', JSON.stringify(settings))
  const cache = await import('../storage/cache')
  await SecureStore.setItemAsync(cache.profileTokenKey('mac', 1), 'token-a')
  // This device has the timelines of every chat but `fresh`, each behind the server except `current`.
  for (const [id, latest] of Object.entries({ open: 20, broken: 10, unread: 10, busy: 10, long: 5, current: 12, later: 5, archived: 1, 'job-run': 1 })) {
    await cache.saveSnapshot('server-a', snapshotOf(id, latest))
  }
  // No periodic refresh: every logged request comes from the step that caused it.
  globalThis.setInterval = (() => 1) as unknown as typeof setInterval
  const { useAppStore } = await import('./useAppStore')
  const appState = NativeAppState as typeof NativeAppState & { __emitAppState(state: string): void }

  await useAppStore.getState().initialize()
  await useAppStore.getState().selectSession('open')
  await waitFor(() => useAppStore.getState().connected && useAppStore.getState().syncStatus !== 'syncing', 'the open chat did not load')
  await new Promise(resolve => setTimeout(resolve, 5_000))
  assert.equal(prefetches().length, 0, 'a server that does not take prefetch is not warmed')
  prefetchCapable = true
  await useAppStore.getState().refreshSessions()

  // Warming, newest first: `broken` (its read fails once, and it is left until it changes), `unread`, `busy` (two
  // pages of 40 and 20) and `long` (a backlog longer than an open merges, so the window the chat shows on open).
  await waitFor(() => prefetches().some(entry => chatOf(entry) === 'long' && entry.query.get('tail') === 'true'), 'the long chat was not warmed')
  await waitFor(() => inFlightPrefetch === 0, 'a background request did not finish')
  const warmed = prefetches()
  assert.deepEqual(warmed.map(entry => [chatOf(entry), entry.query.get('after'), entry.query.get('limit'), entry.query.get('tail')]), [
    ['broken', '10', '40', 'false'],
    ['unread', '10', '40', 'false'],
    ['busy', '10', '40', 'false'],
    ['busy', '50', '40', 'false'],
    ['long', '5', '40', 'false'],
    ['long', null, '240', 'true'],
  ])
  assert.equal(maxInFlightPrefetch, 1, 'one background request at a time')
  for (let index = 1; index < warmed.length; index += 1) {
    if (chatOf(warmed[index]) === 'long' && warmed[index].query.get('tail') === 'true') continue
    assert.ok(warmed[index].start - warmed[index - 1].end >= 1_400, `a pause before ${chatOf(warmed[index])}`)
  }
  assert.ok(!log.some(entry => ['fresh', 'current', 'later', 'archived', 'job-run'].includes(chatOf(entry))), 'no chat outside the warm set or already current is read')
  assert.ok(!log.some(entry => entry.path.endsWith('/read')), 'nothing is marked read')
  assert.ok(isUnread(useAppStore.getState().sessions.find(value => value.id === 'unread')!), 'the unread chat stays unread')

  // The warmed timelines are on disk: the whole backlog of `busy`, the newest window of `long` with older history on
  // demand; opening `busy` then reads only what is newer.
  const busy = await cache.loadSnapshot('server-a', 'busy')
  assert.equal(busy?.latestSeq, 70)
  assert.deepEqual(busy?.events.map(event => event.seq), Array.from({ length: 70 }, (_, index) => index + 1))
  const long = await cache.loadSnapshot('server-a', 'long')
  assert.equal(long?.latestSeq, 400)
  assert.equal(long?.events[0]?.seq, 161)
  assert.equal(long?.hasMore, true)
  let mark = log.length
  await useAppStore.getState().selectSession('busy')
  await waitFor(() => log.slice(mark).some(entry => entry.path === 'GET /api/sessions/busy'), 'opening the warmed chat read nothing')
  const opened = log.slice(mark).find(entry => entry.path === 'GET /api/sessions/busy')!
  assert.equal(opened.query.get('after'), '70', 'the open reads only rows newer than the warmed timeline')
  assert.equal(opened.query.get('prefetch'), null, 'an open is not a prefetch')
  await useAppStore.getState().selectSession('open')
  await waitFor(() => useAppStore.getState().syncStatus !== 'syncing', 'the open chat did not come back')

  // The user's own sync comes first: while the open chat's page is pending, nothing is warmed. (A chat warmed a moment
  // ago waits half a minute before it is read again, so another chat moves here.)
  let release!: () => void
  holdOpenPage = new Promise(resolve => { release = resolve })
  chats.current.latest = 18
  mark = log.length
  const held = useAppStore.getState().syncSelectedSession('manual')
  await useAppStore.getState().refreshSessions()
  await new Promise(resolve => setTimeout(resolve, 4_500))
  assert.equal(prefetches(mark).length, 0, 'no background request while the open chat syncs')
  holdOpenPage = null
  release()
  await held
  await waitFor(() => prefetches(mark).some(entry => chatOf(entry) === 'current' && entry.query.get('after') === '12'), 'the warming did not resume')

  // Only in the foreground.
  await waitFor(() => inFlightPrefetch === 0, 'a background request did not finish')
  appState.__emitAppState('background')
  chats.later.latest = 9
  mark = log.length
  await new Promise(resolve => setTimeout(resolve, 4_000))
  assert.equal(prefetches(mark).length, 0, 'nothing is warmed while the app is away')
  appState.__emitAppState('active')
  await waitFor(() => prefetches(mark).some(entry => chatOf(entry) === 'later' && entry.query.get('after') === '5'), 'the warming did not resume in the foreground')
  // Away again: the open chat's streams stop retrying, so the test process can end.
  appState.__emitAppState('background')
} finally {
  globalThis.setInterval = originalSetInterval
  server.closeAllConnections?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
}

console.log('chat warming store regressions passed')
