import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { lists } from 'react-native-draggable-flatlist'
import { resetComponentStore, useAppStore } from './component-mocks/app-store'
import { Sidebar } from '../src/components/Sidebar'
import type { Health, Session, Surface } from '../src/types'

// Folder actions send the folders the sidebar shows, in display order, except a folder holding only tabs that the
// order does not list. With a shared folder order (folder_order_v1), a rename sends the new name in the old one's
// place before any chat moves, so the server never adds it at the end and other devices do not see the folder jump.

const chat = (id: string, folder: string) => ({ id, title: id, folder, backend: 'codex' }) as Session
const tab = { id: 'term_1', kind: 'terminal', name: null, folder: 'Tabs', cwd: null, url: null, page_title: null, created_at: '', updated_at: '' } as Surface
const sharedOrder: Health = { ok: true, capabilities: { folder_order_v1: { available: true, version: 1, path: '/api/folders/order', stream_protocol: 'agentsdock-session-summaries-v2' } } }
let tree: ReturnType<typeof create> | null = null

type Shown = { sessions?: Session[]; surfaces?: Surface[]; folderOrder?: string[]; collapsedFolders?: string[] }
async function renderSidebar(health: Health, { answer = async () => true, moved = () => true, shown = {} }: { answer?: () => Promise<boolean>; moved?: (id: string) => boolean; shown?: Shown } = {}) {
  const calls: unknown[][] = []
  resetComponentStore({
    switchingProfileId: null,
    serverConfigured: true,
    serverURL: 'http://127.0.0.1:7850',
    health,
    runtime: null,
    sessions: [chat('w1', 'Work'), chat('g1', 'General'), chat('w2', 'Work')],
    surfaces: [tab],
    folderOrder: ['Work', 'General'],
    collapsedFolders: [],
    searchResults: [],
    clearSearch: () => {},
    search: async () => {},
    setCollapsedFolders: (folders: string[]) => { calls.push(['collapsed', folders]) },
    setFolderOrder: (order: string[]) => { calls.push(['order', order]); return answer() },
    updateSession: async (id: string, patch: Partial<Session>) => { calls.push(['patch', id, patch]); return moved(id) },
    updateSurface: async (id: string, patch: Partial<Surface>) => { calls.push(['tab', id, patch]) },
    ...shown,
  } as never)
  await act(async () => {
    tree = create(<Sidebar
      profiles={[]} activeProfileId="profile-a" onSwitchServer={async () => true} onSetupServer={() => {}} onManageServers={() => {}}
      onSettings={() => {}} onTeamNetwork={() => {}} onNewChat={() => {}} onResumeChat={() => {}} onNewChatIn={() => {}} onNewSurfaceIn={() => {}}
    />)
  })
  return calls
}

// A folder or chat menu, as the native menu reports it.
const menu = (testID: string) => tree!.root.findAll(node => node.props.testID === testID && typeof node.props.onPressAction === 'function')[0]
const actionIds = (actions: Array<{ id: string; subactions?: unknown[] }>): string[] =>
  actions.flatMap(action => [action.id, ...actionIds((action.subactions ?? []) as Array<{ id: string }>)])
async function folderAction(folder: string, action: string) {
  await act(async () => { menu(`folder-actions-${folder}`).props.onPressAction({ nativeEvent: { event: action } }) })
}

async function answerPrompt(text: string) {
  const input = tree!.root.findAll(node => node.props.testID === 'text-prompt-input' && typeof node.props.onChangeText === 'function')[0]
  await act(async () => { input.props.onChangeText(text) })
  const confirm = tree!.root.findAll(node => node.props.testID === 'text-prompt-confirm' && typeof node.props.onPress === 'function')[0]
  await act(async () => { confirm.props.onPress() })
}

// Another device changes the shared folder order while a prompt is open.
const otherDeviceReorders = async (folderOrder: string[]) => { await act(async () => { useAppStore.setState({ folderOrder }) }) }

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('with a shared folder order, a rename sends the renamed order before moving the chats', async () => {
  const calls = await renderSidebar(sharedOrder)
  await folderAction('Work', 'rename')
  await answerPrompt('Projects')
  assert.deepEqual(calls, [
    ['order', ['Projects', 'General']],
    ['patch', 'w1', { folder: 'Projects' }],
    ['patch', 'w2', { folder: 'Projects' }],
  ])
})

test('a rename the server refuses moves no chat', async () => {
  const calls = await renderSidebar(sharedOrder, { answer: async () => false })
  await folderAction('Work', 'rename')
  await answerPrompt('Projects')
  assert.deepEqual(calls, [['order', ['Projects', 'General']]])
})

test('on an older server a rename moves the chats first, then renames the folder in this device\'s own order', async () => {
  const calls = await renderSidebar({ ok: true })
  await folderAction('Work', 'rename')
  await answerPrompt('Projects')
  assert.deepEqual(calls, [
    ['patch', 'w1', { folder: 'Projects' }],
    ['patch', 'w2', { folder: 'Projects' }],
    ['order', ['Projects', 'General']],
  ])
})

test('Create and Rename build the order when the name is confirmed, after a change another device made meanwhile', async () => {
  const calls = await renderSidebar(sharedOrder)
  const newFolder = tree!.root.findAll(node => node.props.accessibilityLabel === 'New folder' && typeof node.props.onPress === 'function')[0]
  await act(async () => { newFolder.props.onPress() })
  await otherDeviceReorders(['General', 'Work'])
  await answerPrompt('Ideas')
  assert.deepEqual(calls, [['order', ['General', 'Work', 'Ideas']]])

  calls.length = 0
  await otherDeviceReorders(['Work', 'General'])
  await folderAction('Work', 'rename')
  await otherDeviceReorders(['General', 'Work'])
  await answerPrompt('Projects')
  assert.deepEqual(calls[0], ['order', ['General', 'Projects']])
})

test('a folder whose chats did not all move keeps its place in the order', async () => {
  const calls = await renderSidebar(sharedOrder, { moved: id => id !== 'w2' })
  await folderAction('Work', 'delete')
  assert.deepEqual(calls, [['patch', 'w1', { folder: 'General' }], ['patch', 'w2', { folder: 'General' }]])

  await act(async () => { tree!.unmount() })
  const deleted = await renderSidebar(sharedOrder)
  await folderAction('Work', 'delete')
  assert.deepEqual(deleted.at(-1), ['order', ['General']])
})

test('a folder holding only tabs that the order does not list is not moved, offered as a destination, or sent', async () => {
  const calls = await renderSidebar(sharedOrder)
  const tabsActions = actionIds(menu('folder-actions-Tabs').props.actions)
  assert.ok(!tabsActions.includes('move-up') && !tabsActions.includes('move-down'), `Tabs offers ${tabsActions.join()}`)
  const destinations = actionIds(menu('chat-actions-g1').props.actions).filter(id => id.startsWith('folder:'))
  assert.deepEqual(destinations, ['folder:Work', 'folder:General'])
  await folderAction('Work', 'move-down')
  assert.deepEqual(calls, [['order', ['General', 'Work']]])
})

test('a dragged folder sends the order it was dropped in; a refused order is drawn back', async () => {
  let refuse: (accepted: boolean) => void = () => {}
  const calls = await renderSidebar(sharedOrder, { answer: () => new Promise(resolve => { refuse = resolve }) })
  const keys = (rows: Array<{ key: string }>) => rows.map(row => row.key)
  const shown = lists.at(-1)!.data as Array<{ key: string }>
  assert.deepEqual(keys(shown), ['header:Work', 'w1', 'w2', 'header:General', 'g1', 'header:Tabs', 'term_1'])
  // draggable-flatlist reports the list with only the header moved.
  const drop = async (key: string) => {
    const from = shown.findIndex(row => row.key === key)
    const data = [...shown]
    data.splice(0, 0, ...data.splice(from, 1))
    await act(async () => { lists.at(-1)!.onDragEnd({ data, from, to: 0 }) })
    return data
  }
  // The shared folder order does not take Tabs along, and moving Tabs alone changes nothing.
  await drop('header:Tabs')
  assert.deepEqual(calls, [])
  assert.deepEqual(keys(lists.at(-1)!.data), keys(shown))
  const dropped = await drop('header:General')
  assert.deepEqual(calls, [['order', ['General', 'Work']]])
  // The library resets a dropped row only when the key order changes: the drop shows until the server answers, then
  // the order before it.
  assert.deepEqual(keys(lists.at(-1)!.data), keys(dropped))
  await act(async () => { refuse(false) })
  assert.deepEqual(keys(lists.at(-1)!.data), keys(shown))
})

// Nested folders: a folder's name is its path, "Work/Papers" is Papers in Work. Lab is named by its subfolder only.
const nested: Shown = {
  sessions: [chat('w1', 'Work'), chat('p1', 'Work/Papers'), chat('y1', 'Work/Papers/2026'), chat('c1', 'Work/Code'), chat('l1', 'Lab/Runs'), chat('g1', 'General')],
  surfaces: [{ ...tab, id: 'term_p', folder: 'Work/Papers' }],
  folderOrder: ['Work', 'Work/Papers', 'Work/Papers/2026', 'Work/Code', 'Lab/Runs', 'General'],
}
const nestedOrder = ['Work', 'Work/Papers', 'Work/Papers/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General']
type ShownRow = { key: string; title?: string; count?: number; sessions?: Session[] }
const shownRows = () => lists.at(-1)!.data as ShownRow[]
const shownKeys = () => shownRows().map(row => row.key)
const header = (folder: string) => shownRows().find(row => row.key === `header:${folder}`)!

test('a subfolder is listed under its parent by its own name, and its rows are indented with it', async () => {
  await renderSidebar(sharedOrder, { shown: nested })
  assert.deepEqual(shownKeys(), [
    'header:Work', 'w1', 'header:Work/Papers', 'p1', 'term_p', 'header:Work/Papers/2026', 'y1', 'header:Work/Code', 'c1',
    'header:Lab', 'header:Lab/Runs', 'l1', 'header:General', 'g1',
  ])
  assert.deepEqual(['Work', 'Work/Papers', 'Work/Papers/2026', 'Lab'].map(folder => [header(folder).title, header(folder).count]), [['Work', 1], ['Papers', 2], ['2026', 1], ['Lab', 0]])
  const indent = (testID: string) => {
    let node = tree!.root.findAll(candidate => candidate.props.testID === testID)[0]
    while (node.props.style?.marginLeft === undefined) node = node.parent!
    return node.props.style.marginLeft
  }
  assert.deepEqual(
    ['chat-row-w1', 'folder-actions-Work/Papers', 'chat-row-p1', 'tab-row-term_p', 'folder-actions-Work/Papers/2026', 'chat-row-y1', 'folder-actions-General'].map(indent),
    [0, 14, 14, 14, 28, 28, 0],
  )
})

test('a collapsed folder hides its subfolders, and its header counts and marks the chats and tabs in them', async () => {
  await renderSidebar(sharedOrder, { shown: { ...nested, collapsedFolders: ['Work/Papers'] } })
  assert.deepEqual(shownKeys(), ['header:Work', 'w1', 'header:Work/Papers', 'header:Work/Code', 'c1', 'header:Lab', 'header:Lab/Runs', 'l1', 'header:General', 'g1'])
  // p1, y1 and the terminal; the expanded Work above it counts its own chat only.
  assert.deepEqual([header('Work/Papers').count, header('Work').count], [3, 1])
  const labels = () => tree!.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && / (Work|Papers)(,|$)/.test(node.props.accessibilityLabel)).map(node => node.props.accessibilityLabel)
  await act(async () => { useAppStore.setState({ activeSessionIds: new Set(['y1']) }) })
  assert.deepEqual(labels(), ['Collapse Work', 'Expand Papers, agent running'])

  await act(async () => { useAppStore.setState({ collapsedFolders: ['Work'] }) })
  assert.deepEqual(shownKeys(), ['header:Work', 'header:Lab', 'header:Lab/Runs', 'l1', 'header:General', 'g1'])
  assert.equal(header('Work').count, 5)
  assert.deepEqual(labels(), ['Expand Work, agent running'])
})

test('a folder menu offers a subfolder, the folders it can move into, and Up and Down among the folders of its parent', async () => {
  await renderSidebar(sharedOrder, { shown: nested })
  const ids = (folder: string) => actionIds(menu(`folder-actions-${folder}`).props.actions).filter(id => !id.startsWith('new:') && !['new-terminal', 'new-browser', 'rename', 'delete'].includes(id))
  assert.deepEqual(ids('Work'), ['new-subfolder', 'move-to', 'move-into:Lab', 'move-into:Lab%2FRuns', 'move-into:General', 'move-down'])
  assert.deepEqual(ids('Work/Papers'), ['new-subfolder', 'move-to', 'move-top', 'move-into:Work%2FCode', 'move-into:Lab', 'move-into:Lab%2FRuns', 'move-into:General', 'move-down'])
  assert.deepEqual(ids('Work/Code'), ['new-subfolder', 'move-to', 'move-top', 'move-into:Work%2FPapers', 'move-into:Work%2FPapers%2F2026', 'move-into:Lab', 'move-into:Lab%2FRuns', 'move-into:General', 'move-up'])
  assert.deepEqual(ids('Work/Papers/2026'), ['new-subfolder', 'move-to', 'move-top', 'move-into:Work', 'move-into:Work%2FCode', 'move-into:Lab', 'move-into:Lab%2FRuns', 'move-into:General'])
  // A chat's Move to Folder lists the same folders by path, each before its subfolders.
  assert.deepEqual(actionIds(menu('chat-actions-g1').props.actions).filter(id => id.startsWith('folder:')).map(id => decodeURIComponent(id.slice(7))), nestedOrder)
})

test('Move Folder Up and Down pass the neighbour in the same parent, each with its subfolders', async () => {
  const calls = await renderSidebar(sharedOrder, { shown: nested })
  await folderAction('Work/Code', 'move-up')
  await folderAction('Work', 'move-down')
  assert.deepEqual(calls, [
    ['order', ['Work', 'Work/Code', 'Work/Papers', 'Work/Papers/2026', 'Lab', 'Lab/Runs', 'General']],
    ['order', ['Lab', 'Lab/Runs', 'Work', 'Work/Papers', 'Work/Papers/2026', 'Work/Code', 'General']],
  ])
})

test('renaming a folder edits its own name and moves the chats, tabs and collapsed entries of its subfolders too', async () => {
  const calls = await renderSidebar(sharedOrder, { shown: { ...nested, collapsedFolders: ['Work/Papers/2026', 'General'] } })
  await folderAction('Work/Papers', 'rename')
  assert.equal(tree!.root.findAll(node => node.props.testID === 'text-prompt-input' && typeof node.props.onChangeText === 'function')[0].props.value, 'Papers')
  await answerPrompt('Reading')
  assert.deepEqual(calls, [
    ['order', ['Work', 'Work/Reading', 'Work/Reading/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General']],
    ['patch', 'p1', { folder: 'Work/Reading' }],
    ['patch', 'y1', { folder: 'Work/Reading/2026' }],
    ['tab', 'term_p', { folder: 'Work/Reading' }],
    ['collapsed', ['Work/Reading/2026', 'General']],
  ])
})

test('Move Folder To puts a folder with its chats, tabs and subfolders last in the folder chosen, or last at the top level', async () => {
  const calls = await renderSidebar(sharedOrder, { shown: nested })
  await folderAction('Work/Papers', 'move-into:Lab')
  assert.deepEqual(calls, [
    ['order', ['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'Lab/Papers', 'Lab/Papers/2026', 'General']],
    ['patch', 'p1', { folder: 'Lab/Papers' }],
    ['patch', 'y1', { folder: 'Lab/Papers/2026' }],
    ['tab', 'term_p', { folder: 'Lab/Papers' }],
  ])
  calls.length = 0
  await folderAction('Work/Papers', 'move-top')
  assert.deepEqual(calls[0], ['order', ['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'General', 'Papers', 'Papers/2026']])
  assert.deepEqual(calls[2], ['patch', 'y1', { folder: 'Papers/2026' }])
})

test('a folder is not moved or renamed onto another folder, whatever the case, and no subfolder takes an existing path', async () => {
  const calls = await renderSidebar(sharedOrder, { shown: { ...nested, sessions: [...nested.sessions!, chat('x1', 'Lab/papers')] } })
  await folderAction('Work/Papers', 'move-into:Lab')
  await folderAction('Work/Code', 'rename')
  await answerPrompt('PAPERS')
  await folderAction('Work/Papers', 'new-subfolder')
  await answerPrompt(' 2026 ')
  assert.deepEqual(calls, [])
})

test('New Subfolder adds the folder to the order and expands a collapsed parent', async () => {
  const calls = await renderSidebar(sharedOrder, { shown: { ...nested, collapsedFolders: ['Work/Papers', 'General'] } })
  await folderAction('Work/Papers', 'new-subfolder')
  await answerPrompt('Drafts')
  assert.deepEqual(calls, [['order', [...nestedOrder, 'Work/Papers/Drafts']], ['collapsed', ['General']]])
})

test('deleting a folder removes its subfolders and sends their chats to its parent; from a top-level folder they go to General', async () => {
  const calls = await renderSidebar(sharedOrder, { shown: { ...nested, collapsedFolders: ['Work/Papers/2026', 'General'] } })
  await folderAction('Work/Papers', 'delete')
  // Tabs stay where they are, as before nesting.
  assert.deepEqual(calls, [
    ['patch', 'p1', { folder: 'Work' }],
    ['patch', 'y1', { folder: 'Work' }],
    ['order', ['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'General']],
    ['collapsed', ['General']],
  ])
  calls.length = 0
  await folderAction('Work', 'delete')
  assert.deepEqual(calls, [
    ...['w1', 'p1', 'y1', 'c1'].map(id => ['patch', id, { folder: 'General' }]),
    ['order', ['Lab', 'Lab/Runs', 'General']],
    ['collapsed', ['General']],
  ])
})

test('a dragged subfolder is reordered inside its parent only; dropped elsewhere it is drawn back', async () => {
  const calls = await renderSidebar(sharedOrder, { shown: nested })
  const shown = shownRows()
  // draggable-flatlist reports the list with only the header moved, here to just above the row `before`.
  const drop = async (key: string, before: string) => {
    const from = shown.findIndex(row => row.key === key)
    const data = [...shown]
    const [moved] = data.splice(from, 1)
    const to = data.findIndex(row => row.key === before)
    data.splice(to, 0, moved)
    await act(async () => { lists.at(-1)!.onDragEnd({ data, from, to }) })
  }
  await drop('header:Work/Papers', 'header:Work')
  await drop('header:Work/Papers', 'header:General')
  assert.deepEqual(calls, [])
  assert.deepEqual(shownKeys(), shown.map(row => row.key))
  await drop('header:Work/Code', 'header:Work/Papers')
  assert.deepEqual(calls, [['order', ['Work', 'Work/Code', 'Work/Papers', 'Work/Papers/2026', 'Lab', 'Lab/Runs', 'General']]])
})

test('a folder whose path starts with the name of the Archived section is listed while that section is collapsed', async () => {
  await renderSidebar(sharedOrder, { shown: { sessions: [chat('a1', 'Archived/2024'), { ...chat('old', 'Work'), archived: true }], surfaces: [], folderOrder: ['Archived/2024'] } })
  // Archived starts collapsed: its own chat is hidden, the folder and its chat are not.
  assert.deepEqual(shownKeys().filter(key => key !== 'header:Archived'), ['header:Archived/2024', 'a1'])
})

test('a chat that was not renamed keeps this device\'s order and the collapsed folders as they were', async () => {
  const calls = await renderSidebar({ ok: true }, { moved: id => id !== 'y1', shown: { ...nested, collapsedFolders: ['Work/Papers/2026'] } })
  await folderAction('Work/Papers', 'move-into:Lab')
  assert.deepEqual(calls, [
    ['patch', 'p1', { folder: 'Lab/Papers' }],
    ['patch', 'y1', { folder: 'Lab/Papers/2026' }],
    ['tab', 'term_p', { folder: 'Lab/Papers' }],
  ])
})

test('a folder moved into a collapsed folder expands it, and the collapsed folders are read when the chats have moved', async () => {
  let collapseMeanwhile = true
  const calls = await renderSidebar(sharedOrder, {
    // The user collapses General while the chats are being renamed.
    moved: () => { if (collapseMeanwhile) { collapseMeanwhile = false; useAppStore.setState({ collapsedFolders: ['Lab', 'Work/Papers/2026', 'General'] }) } return true },
    shown: { ...nested, collapsedFolders: ['Lab', 'Work/Papers/2026'] },
  })
  await folderAction('Work/Papers', 'move-into:Lab')
  assert.deepEqual(calls.at(-1), ['collapsed', ['Lab/Papers/2026', 'General']])
})

test('deleting a subfolder sends its chats to the parent as the list spells it', async () => {
  const calls = await renderSidebar(sharedOrder, { shown: { sessions: [chat('r1', 'Lab / Runs'), chat('o1', 'Lab/Runs/Old')], surfaces: [], folderOrder: ['Lab / Runs', 'Lab/Runs/Old'] } })
  await folderAction('Lab/Runs/Old', 'delete')
  // Not to "Lab/Runs", which would be a second folder beside the one stored as "Lab / Runs".
  assert.deepEqual(calls[0], ['patch', 'o1', { folder: 'Lab / Runs' }])
})
