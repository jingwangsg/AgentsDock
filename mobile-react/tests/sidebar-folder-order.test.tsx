import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { lists } from 'react-native-draggable-flatlist'
import { resetComponentStore } from './component-mocks/app-store'
import { Sidebar } from '../src/components/Sidebar'
import type { Health, Session, Surface } from '../src/types'

// Folder actions send the folders the sidebar shows, in display order. On a server that keeps one order for every
// device (folder_order_v1), a rename sends the new name in the old one's place before any chat moves, so the server
// never adds it at the end and other devices do not see the folder jump.

const chat = (id: string, folder: string) => ({ id, title: id, folder, backend: 'codex' }) as Session
const tab = { id: 'term_1', kind: 'terminal', name: null, folder: 'Tabs', cwd: null, url: null, page_title: null, created_at: '', updated_at: '' } as Surface
const sharedOrder: Health = { ok: true, capabilities: { folder_order_v1: { available: true, version: 1, path: '/api/folders/order', stream_protocol: 'agentsdock-session-summaries-v2' } } }
let tree: ReturnType<typeof create> | null = null

async function renderSidebar(health: Health, answer: () => Promise<boolean> = async () => true) {
  const calls: unknown[][] = []
  resetComponentStore({
    switchingProfileId: null,
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
    updateSession: async (id: string, patch: Partial<Session>) => { calls.push(['patch', id, patch]); return true },
  } as never)
  await act(async () => {
    tree = create(<Sidebar
      profiles={[]} activeProfileId="profile-a" onSwitchServer={async () => true} onSetupServer={() => {}} onManageServers={() => {}}
      onSettings={() => {}} onTeamNetwork={() => {}} onNewChat={() => {}} onResumeChat={() => {}} onNewChatIn={() => {}} onNewSurfaceIn={() => {}}
    />)
  })
  return calls
}

// The folder menu's action, as the native menu reports it.
async function folderAction(folder: string, action: string) {
  const menu = tree!.root.findAll(node => node.props.testID === `folder-actions-${folder}` && typeof node.props.onPressAction === 'function')[0]
  await act(async () => { menu.props.onPressAction({ nativeEvent: { event: action } }) })
}

async function answerPrompt(text: string) {
  const input = tree!.root.findAll(node => node.props.testID === 'text-prompt-input' && typeof node.props.onChangeText === 'function')[0]
  await act(async () => { input.props.onChangeText(text) })
  const confirm = tree!.root.findAll(node => node.props.testID === 'text-prompt-confirm' && typeof node.props.onPress === 'function')[0]
  await act(async () => { confirm.props.onPress() })
}

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('on a server that keeps the order, a rename sends the renamed order before moving the chats', async () => {
  const calls = await renderSidebar(sharedOrder)
  await folderAction('Work', 'rename')
  await answerPrompt('Projects')
  assert.deepEqual(calls, [
    ['order', ['Projects', 'General', 'Tabs']],
    ['patch', 'w1', { folder: 'Projects' }],
    ['patch', 'w2', { folder: 'Projects' }],
  ])
})

test('a rename the server refuses moves no chat', async () => {
  const calls = await renderSidebar(sharedOrder, async () => false)
  await folderAction('Work', 'rename')
  await answerPrompt('Projects')
  assert.deepEqual(calls, [['order', ['Projects', 'General', 'Tabs']]])
})

test('on an older server a rename moves the chats first, then renames the folder in this app\'s order', async () => {
  const calls = await renderSidebar({ ok: true })
  await folderAction('Work', 'rename')
  await answerPrompt('Projects')
  assert.deepEqual(calls, [
    ['patch', 'w1', { folder: 'Projects' }],
    ['patch', 'w2', { folder: 'Projects' }],
    ['order', ['Projects', 'General', 'Tabs']],
  ])
})

test('moving a folder sends every folder the sidebar shows, one holding only tabs included', async () => {
  const calls = await renderSidebar(sharedOrder)
  await folderAction('General', 'move-down')
  assert.deepEqual(calls, [['order', ['Work', 'Tabs', 'General']]])
})

test('a dragged folder sends the order it was dropped in; a refused order is drawn back', async () => {
  let refuse: (accepted: boolean) => void = () => {}
  const calls = await renderSidebar(sharedOrder, () => new Promise(resolve => { refuse = resolve }))
  const list = lists.at(-1)!
  const keys = (rows: Array<{ key: string }>) => rows.map(row => row.key)
  const shown = list.data as Array<{ key: string }>
  assert.deepEqual(keys(shown), ['header:Work', 'w1', 'w2', 'header:General', 'g1', 'header:Tabs', 'term_1'])
  // draggable-flatlist reports the list with only the header moved.
  const from = shown.findIndex(row => row.key === 'header:Tabs')
  const data = [...shown]
  data.splice(0, 0, ...data.splice(from, 1))
  await act(async () => { list.onDragEnd({ data, from, to: 0 }) })
  assert.deepEqual(calls, [['order', ['Tabs', 'Work', 'General']]])
  // The library resets a dropped row only when the key order changes: the drop shows until the server answers, then
  // the order before it.
  assert.deepEqual(keys(lists.at(-1)!.data), keys(data))
  await act(async () => { refuse(false) })
  assert.deepEqual(keys(lists.at(-1)!.data), keys(shown))
})
