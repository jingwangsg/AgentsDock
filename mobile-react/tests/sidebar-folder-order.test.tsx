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

async function renderSidebar(health: Health, { answer = async () => true, moved = () => true }: { answer?: () => Promise<boolean>; moved?: (id: string) => boolean } = {}) {
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
    setCollapsedFolders: () => {},
    setFolderOrder: (order: string[]) => { calls.push(['order', order]); return answer() },
    updateSession: async (id: string, patch: Partial<Session>) => { calls.push(['patch', id, patch]); return moved(id) },
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
