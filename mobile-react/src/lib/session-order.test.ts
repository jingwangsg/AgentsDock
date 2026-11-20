import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '../types'
import { folderIsHidden } from './folders'
import { orderedSessionSections, rankMentionRows, rememberedFolderOrder, resolveSidebarDrop, sharesFolderOrder, sidebarFolderOrder, sidebarVisibleSessions, unreadCount, type SidebarDropRow } from './session-order'

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

test('folders missing from folderOrder follow it alphabetically, as on the desktop', () => {
  assert.deepEqual(
    orderedSessionSections([session('z', 'Zeta'), session('g'), session('a', 'alpha')], ['Work'], true, true).map(section => section.id),
    ['Work', 'alpha', 'General', 'Zeta'],
  )
})

test('a folder holding only tabs keeps its place in folderOrder, else follows the chat folders, sorted, before Archived', () => {
  const sessions = [session('w', 'Work'), session('z', 'Zeta'), { ...session('old', 'Work'), archived: true }]
  // Tabs in Work share its section; Ops is placed by the order; Lab and Beta come after the chat folders.
  const tabFolders = ['Lab', 'Ops', 'Work', 'Beta', 'Lab']
  assert.deepEqual(
    orderedSessionSections(sessions, ['Ops', 'Work'], true, true, tabFolders).map(section => [section.id, section.sessions.length]),
    [['Ops', 0], ['Work', 1], ['Zeta', 1], ['Beta', 0], ['Lab', 0], ['Archived', 1]],
  )
  // What folder actions act on and the shared folder order is replaced with: Pinned, Archived and the folders holding
  // only tabs that the order does not list are left out.
  assert.deepEqual(sidebarFolderOrder([{ ...session('p', 'Work'), pinned: true }, ...sessions], ['Ops', 'Work']), ['Ops', 'Work', 'Zeta'])
})

test('a folder is listed directly before its subfolders, with a parent that only subfolders name', () => {
  const sessions = [session('p', 'Work/Papers'), session('g'), session('o', 'Ops'), session('r', 'Lab/Runs/Old'), { ...session('pin', 'Work/Code'), pinned: true }, { ...session('old', 'Work/Code'), archived: true }]
  // Work and Lab hold no chat and the order does not list them; Lab/Runs/Old follows the order alphabetically.
  assert.deepEqual(
    orderedSessionSections(sessions, ['Ops', 'Work/Papers', 'General', 'Work/Code'], true, true).map(section => [section.id, section.sessions.length]),
    [['Pinned', 1], ['Ops', 1], ['Work', 0], ['Work/Papers', 1], ['Work/Code', 0], ['General', 1], ['Lab', 0], ['Lab/Runs', 0], ['Lab/Runs/Old', 1], ['Archived', 1]],
  )
  assert.deepEqual(sidebarFolderOrder(sessions, ['Ops', 'Work/Papers', 'General', 'Work/Code']), ['Ops', 'Work', 'Work/Papers', 'Work/Code', 'General', 'Lab', 'Lab/Runs', 'Lab/Runs/Old'])
  // A folder holding only tabs goes under its parent too, after the parent's chat folders.
  assert.deepEqual(
    orderedSessionSections(sessions, ['Ops', 'Work/Papers', 'General'], false, true, ['Work/Terminals', 'Ops']).map(section => section.id),
    ['Pinned', 'Ops', 'Work', 'Work/Papers', 'Work/Terminals', 'General', 'Lab', 'Lab/Runs', 'Lab/Runs/Old'],
  )
  // Filtered results keep the parents of a folder with a match, so its place in the tree stays readable.
  assert.deepEqual(
    orderedSessionSections([session('r', 'Lab/Runs/Old')], ['Ops', 'Work/Papers']).map(section => [section.id, section.sessions.length]),
    [['Lab', 0], ['Lab/Runs', 0], ['Lab/Runs/Old', 1]],
  )
})

test('with a shared folder order, a dropped folder order leaves out folders holding only tabs it does not list', () => {
  const sessions = [session('w1', 'Work'), session('a')]
  const folders = ['Work', 'General']
  // As the sidebar draws it: Tabs holds only tabs, so it follows the chat folders.
  const rows: SidebarDropRow[] = [...rowsOf(sessions, folders), { kind: 'header', folder: 'Tabs' }]
  // General dragged above Work: this device's own order takes Tabs along, the shared folder order does not.
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 2, 0), 0, sessions, folders), { kind: 'folder-order', order: ['General', 'Work', 'Tabs'] })
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 2, 0), 0, sessions, folders, true), { kind: 'folder-order', order: ['General', 'Work'] })
  // Dragging Tabs itself changes nothing in the shared folder order.
  assert.equal(resolveSidebarDrop(dropped(rows, 4, 0), 0, sessions, folders, true), null)
})

test('only a server advertising folder_order_v1 keeps the folder order', () => {
  assert.equal(sharesFolderOrder({ ok: true, capabilities: { folder_order_v1: { available: true, version: 1, path: '/api/folders/order', stream_protocol: 'agentsdock-session-summaries-v2' } } }), true)
  assert.equal(sharesFolderOrder({ ok: true, capabilities: {} }), false)
  assert.equal(sharesFolderOrder(null), false)
})

test('remembered folder order keeps folders that only exist on sessions, General included', () => {
  assert.deepEqual(rememberedFolderOrder(['Work'], [session('x', 'Personal'), session('y', 'Work'), session('z')]), ['Work', 'Personal', 'General'])
  assert.deepEqual(rememberedFolderOrder([], [session('z')]), ['General'])
  const same = ['Work']
  assert.equal(rememberedFolderOrder(same, [session('y', 'Work')]), same)
})

// As the sidebar draws it: a collapsed folder shows its header only, and none of its subfolders.
function rowsOf(sessions: Session[], folderOrder: string[], collapsed: string[] = []): SidebarDropRow[] {
  return orderedSessionSections(sessions, folderOrder, true, true).filter(section => !folderIsHidden(section.id, collapsed)).flatMap<SidebarDropRow>(section => [
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

const nested = [session('w', 'Work'), session('p', 'Work/Papers'), session('c', 'Work/Code'), session('l', 'Lab'), session('g')]
const nestedFolders = ['Work', 'Work/Papers', 'Work/Code', 'Lab', 'General']
const names = (rows: SidebarDropRow[]) => rows.map(row => row.kind === 'header' ? row.folder : row.session.id)

test('a dragged folder is reordered among the folders of its parent, and its subfolders move with it', () => {
  const rows = rowsOf(nested, nestedFolders)
  assert.deepEqual(names(rows), ['Work', 'w', 'Work/Papers', 'p', 'Work/Code', 'c', 'Lab', 'l', 'General', 'g'])
  // Only the dragged header moves in the list. Work dropped under Lab's chat lands before General.
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 0, 7), 7, nested, nestedFolders), { kind: 'folder-order', order: ['Lab', 'Work', 'Work/Papers', 'Work/Code', 'General'] })
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 8, 0), 0, nested, nestedFolders), { kind: 'folder-order', order: ['General', 'Work', 'Work/Papers', 'Work/Code', 'Lab'] })
  // Inside Work: before the other subfolder, or after it and its chats, which is the end of Work.
  const swapped = { kind: 'folder-order', order: ['Work', 'Work/Code', 'Work/Papers', 'Lab', 'General'] }
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 4, 2), 2, nested, nestedFolders), swapped)
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 2, 5), 5, nested, nestedFolders), swapped)
  // A folder dragged past the last folder at the top goes after it and all of its subfolders.
  const lastHasSubfolders = ['Lab', 'General', 'Work', 'Work/Papers', 'Work/Code']
  const lastRows = rowsOf(nested, lastHasSubfolders)
  assert.deepEqual(resolveSidebarDrop(dropped(lastRows, 0, lastRows.length - 1), lastRows.length - 1, nested, lastHasSubfolders), { kind: 'folder-order', order: ['General', 'Work', 'Work/Papers', 'Work/Code', 'Lab'] })
})

test('a folder dropped outside its parent, or between the subfolders of another folder, stays where it was', () => {
  const rows = rowsOf(nested, nestedFolders)
  // Work/Papers under Lab, and above Work.
  assert.equal(resolveSidebarDrop(dropped(rows, 2, 7), 7, nested, nestedFolders), null)
  assert.equal(resolveSidebarDrop(dropped(rows, 2, 0), 0, nested, nestedFolders), null)
  // Lab between Work/Papers and Work/Code.
  assert.equal(resolveSidebarDrop(dropped(rows, 6, 4), 4, nested, nestedFolders), null)
  // Work under its own subfolders: still before Lab.
  assert.equal(resolveSidebarDrop(dropped(rows, 0, 5), 5, nested, nestedFolders), null)
})

test('a folder dragged past a collapsed folder keeps the subfolders that have no header in the order', () => {
  const rows = rowsOf(nested, nestedFolders, ['Work'])
  assert.deepEqual(names(rows), ['Work', 'Lab', 'l', 'General', 'g'])
  const order = { kind: 'folder-order', order: ['Lab', 'Work', 'Work/Papers', 'Work/Code', 'General'] }
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 1, 0), 0, nested, nestedFolders), order)
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 0, 2), 2, nested, nestedFolders), order)
})

test('a chat dropped under the header of a subfolder moves to that subfolder', () => {
  const rows = rowsOf(nested, nestedFolders)
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 9, 3), 3, nested, nestedFolders), { kind: 'reorder', sessionId: 'g', targetId: 'p', placement: 'before', targetFolder: 'Work/Papers' })
  // Under a collapsed folder it goes to that folder, not to a subfolder the collapse hides.
  const collapsed = rowsOf(nested, nestedFolders, ['Work'])
  assert.deepEqual(resolveSidebarDrop(dropped(collapsed, 4, 1), 1, nested, nestedFolders), { kind: 'reorder', sessionId: 'g', targetId: 'w', placement: 'before', targetFolder: 'Work' })
})

test('folders holding only tabs are reordered among themselves in this device\'s own order', () => {
  const sessions = [session('w', 'Work')]
  // As the sidebar draws them: after the chat folders, in plain sort order.
  const rows: SidebarDropRow[] = [...rowsOf(sessions, ['Work']), { kind: 'header', folder: 'Alpha' }, { kind: 'header', folder: 'Beta' }]
  assert.deepEqual(resolveSidebarDrop(dropped(rows, 3, 2), 2, sessions, ['Work']), { kind: 'folder-order', order: ['Work', 'Beta', 'Alpha'] })
})

test('a standalone job run chat, archived or not, is listed only while it is open', () => {
  const parent = session('parent', 'Research')
  const running = { ...session('run-live', 'Research'), scheduled_job_run: { job_id: 'job-1', session_id: 'parent' } } as Session
  const finished = { ...session('run-done', 'Research'), archived: true, scheduled_job_run: { job_id: 'job-1', session_id: 'parent' } } as Session
  assert.deepEqual(sidebarVisibleSessions([parent, running, finished], null).map(value => value.id), ['parent'])
  assert.deepEqual(sidebarVisibleSessions([parent, running, finished], 'run-live').map(value => value.id), ['parent', 'run-live'])
  assert.deepEqual(sidebarVisibleSessions([parent, running, finished], 'run-done').map(value => value.id), ['parent', 'run-done'])
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
