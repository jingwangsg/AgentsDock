import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import { ResumeChatDialog } from '../src/components/ResumeChatDialog'
import type { BulkImportSessionItem, BulkImportSessionResult, CreateSessionInput, LocalSessionCandidate, Session } from '../src/types'

const capability = { available: true, required: false, message: '', action: null, version: 1, max_batch_items: 2, max_list_items: 500 }
const health = { ok: true, api_contract_version: 15, default_cwd: '/home/me', capabilities: { local_session_import_v1: capability } }
const candidates: LocalSessionCandidate[] = [
  { provider_session_id: 'claude-a1', backend: 'claude', label: 'Fix parser', updated_at: '2026-10-07T08:00:00Z', cwd: '/work/alpha' },
  { provider_session_id: 'codex-a2', backend: 'codex', label: 'Write tests', updated_at: '2026-10-07T07:00:00Z', cwd: '/work/alpha' },
  { provider_session_id: 'codex-a3', backend: 'codex', label: 'Refactor', updated_at: '2026-10-07T06:00:00Z', cwd: '/work/alpha' },
  { provider_session_id: 'claude-b1', backend: 'claude', label: 'Deploy notes', updated_at: '2026-10-06T06:00:00Z', cwd: '/work/beta' },
]
const existing = { id: 'chat-existing', title: 'Existing chat', backend: 'codex', folder: 'General', cwd: '/work/alpha', codex_thread_id: 'thread-known' } as Session
const ok = (item: BulkImportSessionItem): BulkImportSessionResult => ({ provider_session_id: item.provider_session_id, backend: item.backend, session_id: `chat-${item.provider_session_id}`, ok: true, imported: 2 })
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

let tree: ReturnType<typeof create> | null = null
let serverSessions: Session[]
let calls: { list: unknown[][]; imports: BulkImportSessionItem[][]; creates: CreateSessionInput[]; ownerLookups: number; refreshes: number; selects: string[]; closes: number; opens: number }
const byId = (id: string) => tree!.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)
const one = (id: string) => { const [node] = byId(id); assert.ok(node, `missing ${id}`); return node }
const press = async (id: string, index = 0) => { await act(async () => { await byId(id)[index].props.onPress() }) }
const type = async (id: string, value: string) => { await act(async () => { one(id).props.onChangeText(value) }) }
const text = () => JSON.stringify(tree!.toJSON())
const render = async (visible = true) => {
  const dialog = <ResumeChatDialog visible={visible} onClose={() => { calls.closes++ }} onOpened={() => { calls.opens++ }} />
  await act(async () => { if (tree) tree.update(dialog); else tree = create(dialog) })
}

beforeEach(() => {
  calls = { list: [], imports: [], creates: [], ownerLookups: 0, refreshes: 0, selects: [], closes: 0, opens: 0 }
  serverSessions = [existing]
  resetComponentStore({
    health,
    sessions: [existing],
    selectedSessionId: null,
    switchingProfileId: null,
    runtime: null,
    refreshSessions: async () => { calls.refreshes++; useAppStore.setState({ sessions: [...serverSessions] } as never) },
    // Like the store, selection is published before the timeline sync starts.
    selectSession: async (id: string) => { calls.selects.push(id); useAppStore.setState({ selectedSessionId: id } as never) },
  } as never)
  setTestClient({
    listLocalSessions: async (...args: unknown[]) => { calls.list.push(args); return candidates },
    bulkImportSessions: async (items: BulkImportSessionItem[]) => {
      calls.imports.push(items)
      const results = items.map(ok)
      serverSessions.push(...results.map(result => ({ id: result.session_id }) as Session))
      return results
    },
    createSession: async (input: CreateSessionInput) => { calls.creates.push(input); serverSessions.push({ id: 'chat-created' } as Session); return { id: 'chat-created' } as Session },
    sessionsWithProviderIds: async () => { calls.ownerLookups++; return [existing] },
  } as never)
})
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('server history is grouped by folder and imports the selection in server-sized batches', async () => {
  await render()
  assert.deepEqual(calls.list, [[500, false]])
  assert.equal(byId('resume-chat-folder').length, 2)
  assert.equal(byId('resume-chat-candidate').length, 0, 'folders start collapsed')
  await press('resume-chat-folder')
  assert.equal(byId('resume-chat-candidate').length, 3)
  await press('resume-chat-select-all')
  assert.equal(one('resume-chat-import').props.accessibilityLabel, 'Import 4')
  await press('resume-chat-import')
  assert.deepEqual(calls.imports.map(batch => batch.map(item => item.provider_session_id)), [['claude-a1', 'codex-a2'], ['codex-a3', 'claude-b1']])
  assert.deepEqual(calls.imports[0][0], { provider_session_id: 'claude-a1', backend: 'claude', cwd: '/work/alpha' })
  assert.equal(calls.refreshes, 1)
  assert.equal(calls.closes, 1)
  assert.deepEqual(calls.selects, [], 'a multi-select import does not switch chats')
})

test('a partial import failure keeps the dialog open with the error and re-scans the history', async () => {
  setTestClient({
    listLocalSessions: async (...args: unknown[]) => { calls.list.push(args); return calls.list.length === 1 ? candidates : candidates.slice(1) },
    bulkImportSessions: async (items: BulkImportSessionItem[]) => {
      calls.imports.push(items)
      if (calls.imports.length === 2) throw new Error('network down')
      return items.map(ok)
    },
  } as never)
  await render()
  await press('resume-chat-select-all')
  await press('resume-chat-import')
  assert.equal(calls.closes, 0)
  assert.equal(calls.refreshes, 1, 'the successful batch still refreshes the chat list')
  assert.equal(calls.list.length, 2, 'the history is scanned again')
  assert.equal(one('resume-chat-import').props.accessibilityLabel, 'Import', 'the selection is cleared')
  await press('resume-chat-folder')
  assert.match(text(), /The import request failed: network down/)
})

test('a session ID found in server history is imported and opened', async () => {
  await render()
  await type('resume-chat-id', ' codex-a2 ')
  await press('resume-chat-submit')
  assert.deepEqual(calls.imports, [[{ provider_session_id: 'codex-a2', backend: 'codex', cwd: '/work/alpha' }]])
  assert.equal(calls.refreshes, 1)
  assert.deepEqual(calls.selects, ['chat-codex-a2'])
  assert.equal(calls.closes, 1)
  assert.equal(calls.opens, 1)
})

test('an ID that an AgentsDock chat already owns opens that chat without a request', async () => {
  await render()
  await type('resume-chat-id', 'thread-known')
  await press('resume-chat-submit')
  assert.deepEqual(calls.imports, [])
  assert.deepEqual(calls.creates, [])
  assert.deepEqual(calls.selects, ['chat-existing'])
  assert.equal(calls.opens, 1)
})

test('an ID owned by a chat whose list row is a summary opens that chat instead of creating a second one', async () => {
  // The server's summary list omits provider IDs; only its full rows name the owner.
  useAppStore.setState({ sessions: [{ ...existing, codex_thread_id: undefined }] } as never)
  await render()
  await type('resume-chat-id', 'thread-known')
  await press('resume-chat-submit')
  assert.equal(calls.ownerLookups, 1)
  assert.deepEqual(calls.creates, [])
  assert.deepEqual(calls.imports, [])
  assert.equal(byId('resume-chat-cwd').length, 0, 'the new-session details never appear')
  assert.deepEqual(calls.selects, ['chat-existing'])
  assert.equal(calls.opens, 1)
})

test('an unknown ID asks for its agent and directory, then resumes through chat creation', async () => {
  await render()
  await type('resume-chat-id', 'abcd1234-unknown')
  await press('resume-chat-submit')
  assert.deepEqual(calls.creates, [], 'the first submit only reveals the details')
  assert.equal(calls.ownerLookups, 1)
  assert.equal(one('resume-chat-cwd').props.value, '/home/me')
  await press('resume-chat-backend-claude')
  await type('resume-chat-cwd', '/work/gamma')
  await press('resume-chat-submit')
  assert.equal(calls.ownerLookups, 2, 'ownership is checked again right before creating')
  assert.deepEqual(calls.creates, [{ title: 'Resumed Claude abcd1234', folder: 'General', cwd: '/work/gamma', backend: 'claude', model: null, effort: null, system_prompt: null, providerId: 'abcd1234-unknown' }])
  assert.deepEqual(calls.selects, ['chat-created'])
  assert.equal(calls.opens, 1)
})

test('a server without history import still resumes by ID and never lists', async () => {
  useAppStore.setState({ health: { ok: true, api_contract_version: 14, default_cwd: '/home/me', capabilities: {} } } as never)
  await render()
  assert.deepEqual(calls.list, [])
  assert.match(text(), /Resume by session ID still works/)
  await type('resume-chat-id', 'provider-old-server')
  await press('resume-chat-submit') // reveals the agent and directory
  await press('resume-chat-submit') // creates the chat
  assert.equal(calls.creates.length, 1)
  assert.equal(calls.creates[0].backend, 'codex')
})

test('a resume answered after the server switched is dropped', async () => {
  const pending = deferred<BulkImportSessionResult[]>()
  setTestClient({
    listLocalSessions: async () => candidates,
    bulkImportSessions: (items: BulkImportSessionItem[]) => { calls.imports.push(items); return pending.promise },
  } as never)
  await render()
  await type('resume-chat-id', 'claude-b1')
  let submitted!: Promise<unknown>
  await act(async () => { submitted = one('resume-chat-submit').props.onPress() })
  await act(async () => { useAppStore.setState({ profileGeneration: 2 } as never) })
  await act(async () => { pending.resolve(calls.imports[0].map(ok)); await submitted })
  assert.equal(calls.refreshes, 0)
  assert.deepEqual(calls.selects, [])
  assert.equal(calls.opens, 0)
})

test('the keyboard Go key waits for the history scan instead of cancelling it', async () => {
  const scan = deferred<LocalSessionCandidate[]>()
  setTestClient({ listLocalSessions: () => scan.promise, sessionsWithProviderIds: async () => { calls.ownerLookups++; return [existing] } } as never)
  await render()
  await type('resume-chat-id', 'codex-a3')
  await act(async () => { await one('resume-chat-id').props.onSubmitEditing() })
  assert.equal(calls.ownerLookups, 0, 'nothing is submitted while the scan runs')
  await act(async () => { scan.resolve(candidates) })
  assert.equal(byId('resume-chat-folder').length, 2, 'the scan result is still shown')
})

test('closing the sheet during an import still sends every batch and refreshes the chat list', async () => {
  const firstBatch = deferred<BulkImportSessionResult[]>()
  setTestClient({
    listLocalSessions: async () => candidates,
    bulkImportSessions: (items: BulkImportSessionItem[]) => {
      calls.imports.push(items)
      return calls.imports.length === 1 ? firstBatch.promise : Promise.resolve(items.map(ok))
    },
  } as never)
  await render()
  await press('resume-chat-select-all')
  let importing!: Promise<unknown>
  await act(async () => { importing = one('resume-chat-import').props.onPress() })
  await render(false)
  await act(async () => { firstBatch.resolve(calls.imports[0].map(ok)); await importing })
  assert.equal(calls.imports.length, 2)
  assert.equal(calls.refreshes, 1)
})

test('reopening the sheet while a request is pending accepts a new one', async () => {
  const firstLookup = deferred<Session[]>()
  setTestClient({
    listLocalSessions: async () => candidates,
    sessionsWithProviderIds: () => { calls.ownerLookups++; return calls.ownerLookups === 1 ? firstLookup.promise : Promise.resolve([existing]) },
  } as never)
  await render()
  await type('resume-chat-id', 'thread-unknown')
  let first!: Promise<unknown>
  await act(async () => { first = one('resume-chat-submit').props.onPress() })
  await render(false)
  await render()
  await type('resume-chat-id', 'thread-unknown')
  await press('resume-chat-submit')
  assert.equal(calls.ownerLookups, 2)
  assert.equal(byId('resume-chat-cwd').length, 1, 'the new request reached the details step')
  await act(async () => { firstLookup.resolve([]); await first })
})

test('on a phone the chat opens without waiting for its timeline sync', async () => {
  const sync = deferred<void>()
  useAppStore.setState({ selectSession: (id: string) => { calls.selects.push(id); useAppStore.setState({ selectedSessionId: id } as never); return sync.promise } } as never)
  await render()
  await type('resume-chat-id', 'thread-known')
  let submitted!: Promise<unknown>
  await act(async () => { submitted = one('resume-chat-submit').props.onPress() })
  assert.equal(calls.opens, 1)
  await act(async () => { sync.resolve(); await submitted })
})

test('a refresh that predates the resumed chat is followed by one that lists it', async () => {
  // The first refresh stands for one already in flight, which the store hands back to this caller.
  useAppStore.setState({ refreshSessions: async () => { calls.refreshes++; if (calls.refreshes > 1) useAppStore.setState({ sessions: [...serverSessions] } as never) } } as never)
  await render()
  await type('resume-chat-id', 'codex-a2')
  await press('resume-chat-submit')
  assert.equal(calls.refreshes, 2)
  assert.deepEqual(calls.selects, ['chat-codex-a2'])
  assert.equal(calls.opens, 1)
})
