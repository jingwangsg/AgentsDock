import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '../types'
import { orderedSessionSections, rankMentionRows, rememberedFolderOrder, resolveSidebarDrop, sidebarVisibleSessions, unreadCount, type SidebarDropRow } from './session-order'

function session(id: string, folder = 'General'): Session {
  return { id, title: id, folder, backend: 'codex' } as Session
}

test('explicitly created custom folders remain visible before they contain chats', () => {
  assert.deepEqual(
    orderedSessionSections([session('general')], ['Empty folder'], true, true).map(section => [section.id, section.sessions.length]),
    [['Empty folder', 0], ['General', 1]],
  )
})

test('reserved empty sections stay hidden', () => {
  assert.deepEqual(
    orderedSessionSections([session('work', 'Work')], []).map(section => section.id),
    ['Work'],
  )
})

test('empty folders stay out of filtered results', () => {
  assert.deepEqual(
    orderedSessionSections([], ['Empty folder']).map(section => section.id),
    [],
  )
})

test('a folder in folderOrder is kept in the unfiltered sidebar when it holds no visible chat', () => {
  assert.deepEqual(
    orderedSessionSections([{ ...session('a', 'Work'), archived: true }], ['Work'], true, true).map(section => section.id),
    ['Work', 'Archived'],
  )
})

test('General takes its folderOrder position like any other folder', () => {
  assert.deepEqual(
    orderedSessionSections([session('g'), session('w', 'Work'), session('p', 'Personal')], ['Work', 'General', 'Personal']).map(section => section.id),
    ['Work', 'General', 'Personal'],
  )
})

test('General is hidden when it is empty and not in folderOrder', () => {
  assert.deepEqual(
    orderedSessionSections([session('w', 'Work'), { ...session('p', 'Work'), pinned: true }], ['Work'], true, true).map(section => section.id),
    ['Pinned', 'Work'],
  )
})

test('folders missing from folderOrder follow it in first-seen order', () => {
  assert.deepEqual(
    orderedSessionSections([session('z', 'Zeta'), session('g'), session('a', 'Alpha')], ['Work'], true, true).map(section => section.id),
    ['Work', 'Zeta', 'General', 'Alpha'],
  )
})

test('remembered folder order keeps folders that only exist on sessions, General included', () => {
  assert.deepEqual(rememberedFolderOrder(['Work'], [session('x', 'Personal'), session('y', 'Work'), session('z')]), ['Work', 'Personal', 'General'])
  assert.deepEqual(rememberedFolderOrder([], [session('z')]), ['General'])
  const same = ['Work']
  assert.equal(rememberedFolderOrder(same, [session('y', 'Work')]), same)
})

function rowsOf(sessions: Session[], folderOrder: string[], collapsed: string[] = []): SidebarDropRow[] {
  return orderedSessionSections(sessions, folderOrder, true, true).flatMap<SidebarDropRow>(section => [
    { kind: 'header', folder: section.id },
    ...(collapsed.includes(section.id) ? [] : section.sessions.map(value => ({ kind: 'session' as const, session: value }))),
  ])
}

// The list as draggable-flatlist reports it after moving row `from` to `to`.
function dropped(rows: SidebarDropRow[], from: number, to: number): SidebarDropRow[] {
  const next = [...rows]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

test('dragging a chat within its folder reorders it next to its new neighbour', () => {
  const sessions = [session('a'), session('b'), session('c')].map((value, index) => ({ ...value, sort_order: index }))
  const rows = rowsOf(sessions, [])
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 3, 1), 1, sessions, ['General']), { kind: 'reorder', sessionId: 'c', targetId: 'a', placement: 'before' })
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 1, 2), 2, sessions, ['General']), { kind: 'reorder', sessionId: 'a', targetId: 'b', placement: 'after' })
})

test('dragging a chat into another folder names that folder for the server', () => {
  const sessions = [session('w1', 'Work'), session('w2', 'Work'), session('a')]
  const rows = rowsOf(sessions, ['Work', 'General'])
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 4, 2), 2, sessions, ['Work', 'General']), { kind: 'reorder', sessionId: 'a', targetId: 'w1', placement: 'after', targetFolder: 'Work' })
})

test('a pinned chat dragged into a folder leaves Pinned, but nothing is dragged into Pinned or Archived', () => {
  const sessions = [{ ...session('p'), pinned: true }, session('a'), { ...session('z'), archived: true }]
  const rows = rowsOf(sessions, [])
  assert.deepEqual(rows.map(row => row.kind === 'header' ? row.folder : row.session.id), ['Pinned', 'p', 'General', 'a', 'Archived', 'z'])
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 1, 3), 3, sessions, ['General']), { kind: 'reorder', sessionId: 'p', targetId: 'a', placement: 'after', targetFolder: 'General' })
  assert.equal(resolveSidebarDrop(dropped(rows, 3, 1), 1, sessions, ['General']), null)
  assert.equal(resolveSidebarDrop(dropped(rows, 3, 5), 5, sessions, ['General']), null)
  assert.equal(resolveSidebarDrop(dropped(rows, 1, 0), 0, sessions, ['General']), null)
})

test('a chat dropped under a collapsed folder goes first in it; under an empty folder it just moves there', () => {
  const sessions = [session('w1', 'Work'), session('a')]
  const collapsed = rowsOf(sessions, ['Work', 'General'], ['Work'])
  assert.deepEqual(resolveSidebarDrop(dropped(collapsed, 2, 1), 1, sessions, ['Work', 'General']), { kind: 'reorder', sessionId: 'a', targetId: 'w1', placement: 'before', targetFolder: 'Work' })
  const empty = rowsOf([session('a')], ['Empty', 'General'])
  assert.deepEqual(resolveSidebarDrop(dropped(empty, 2, 1), 1, [session('a')], ['Empty', 'General']), { kind: 'move', sessionId: 'a', folder: 'Empty' })
})

test('dragging a folder header reorders folders and keeps Pinned and Archived out of the order', () => {
  const sessions = [{ ...session('p'), pinned: true }, session('w1', 'Work'), session('a'), { ...session('z'), archived: true }]
  const rows = rowsOf(sessions, ['Work', 'General'])
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 4, 2), 2, sessions, ['Work', 'General']), { kind: 'folder-order', order: ['General', 'Work'] })
  // Landing inside its own neighbourhood leaves the folder order as it was.
  assert.equal(resolveSidebarDrop(dropped(rows, 2, 3), 3, sessions, ['Work', 'General']), null)
})

test('a standalone job run chat is listed only while it is open or once archived', () => {
  const parent = session('parent', 'Research')
  const running = { ...session('run-live', 'Research'), scheduled_job_run: { job_id: 'job-1', session_id: 'parent' } } as Session
  const finished = { ...session('run-done', 'Research'), archived: true, scheduled_job_run: { job_id: 'job-1', session_id: 'parent' } } as Session
  assert.deepEqual(sidebarVisibleSessions([parent, running, finished], null).map(value => value.id), ['parent', 'run-done'])
  assert.deepEqual(sidebarVisibleSessions([parent, running, finished], 'run-live').map(value => value.id), ['parent', 'run-live', 'run-done'])
})

test('the unread count leaves out archived chats and the job run chats the sidebar hides', () => {
  const unread = { latest_agent_event_seq: 2, last_read_agent_event_seq: 1 }
  const run = { job_id: 'job-1', session_id: 'parent' }
  const counted = [{ ...session('parent'), ...unread }, { ...session('marked'), manual_unread: true }]
  const leftOut = [
    { ...session('read'), latest_agent_event_seq: 3, last_read_agent_event_seq: 3 },
    { ...session('archived'), ...unread, archived: true },
    { ...session('run-live'), ...unread, scheduled_job_run: run },
  ]
  assert.equal(unreadCount([...counted, ...leftOut] as Session[]), counted.length)
})

test('@ picker rows rank a title match first, then every term matching a field in order, then other matches', () => {
  const rows = [
    { id: 'chat-1a', title: 'Launch agent team 负载均衡检查', folder: 'General', server: 'osmo_dev_l40' },
    { id: 'chat-2b', title: 'OSMO 定制功能与负载均衡', folder: 'AgentsDock', server: '' },
    { id: 'chat-3c', title: 'Launch check', folder: 'General', server: '' },
    { id: 'chat-4d', title: 'Slack 搜索 OSMO GitLab', folder: 'General', server: '' },
    { id: 'chat-5e7f', title: 'Launch nightly check', folder: 'General', server: '' },
  ]
  const rank = (query: string) => rankMentionRows(rows, query, row => [row.title, row.folder, row.server], row => row.id.includes(query))
    .map(row => row.title)
  // Title matches lead: exact, then prefix, then substring; ties keep the given order.
  assert.deepEqual(rank('launch check'), ['Launch check', 'Launch nightly check'])
  assert.deepEqual(rank('launch'), ['Launch agent team 负载均衡检查', 'Launch check', 'Launch nightly check'])
  assert.deepEqual(rank('osmo'), ['OSMO 定制功能与负载均衡', 'Slack 搜索 OSMO GitLab', 'Launch agent team 负载均衡检查'])
  // Each term matches on its own, in any field and with gaps.
  assert.deepEqual(rank('launch 负载'), ['Launch agent team 负载均衡检查'])
  assert.deepEqual(rank('l40 负载检查'), ['Launch agent team 负载均衡检查'])
  // A chat id is found by otherMatch only.
  assert.deepEqual(rank('5e7f'), ['Launch nightly check'])
  assert.deepEqual(rank('zzz'), [])
  assert.deepEqual(rank(''), rows.map(row => row.title))
})
