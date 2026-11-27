import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { AccessibilityInfo, Alert } from './component-mocks/react-native'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import { clipboardWrites } from './mocks/expo-clipboard'
import { Sidebar } from '../src/components/Sidebar'
import type { Session } from '../src/types'

// The chat list (GET /api/sessions?summary=true) carries no provider session ID, and an ID the app holds can
// predate a rewind that changed it on the server. Copy Session ID reads the server's full chat list each time.

const held = { id: 'held', title: 'Held', folder: 'General', backend: 'claude', claude_session_id: 'claude-before-rewind' } as Session
const listed = { id: 'listed', title: 'Listed', folder: 'General', backend: 'codex' } as Session
let tree: ReturnType<typeof create> | null = null

async function renderSidebar(serverList: () => Promise<Session[]>) {
  const reads = { count: 0 }
  setTestClient({ sessionsWithProviderIds: () => { reads.count += 1; return serverList() } })
  resetComponentStore({
    switchingProfileId: null,
    serverConfigured: true,
    serverURL: 'http://127.0.0.1:7850',
    runtime: null,
    sessions: [held, listed],
    surfaces: [],
    folderOrder: ['General'],
    collapsedFolders: [],
    searchResults: [],
    clearSearch: () => {},
    search: async () => {},
  } as never)
  clipboardWrites.length = 0
  Alert.__reset()
  AccessibilityInfo.__reset()
  await act(async () => {
    tree = create(<Sidebar
      profiles={[]} activeProfileId="profile-a" onSwitchServer={async () => true} onSetupServer={() => {}} onManageServers={() => {}}
      onSettings={() => {}} onTeamNetwork={() => {}} onNewChat={() => {}} onResumeChat={() => {}} onNewChatIn={() => {}} onNewSurfaceIn={() => {}}
    />)
  })
  return reads
}

const menu = (id: string) => tree!.root.findAll(node => node.props.testID === `chat-actions-${id}` && typeof node.props.onPressAction === 'function')[0]
async function copySessionId(id: string) {
  await act(async () => {
    menu(id).props.onPressAction({ nativeEvent: { event: 'copy-session-id' } })
    // The menu event does not wait for the action; give its read and clipboard write a turn to finish.
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}
const alerts = () => Alert.__calls.map(call => [call.title, call.message])
const serverSwitch = () => { useAppStore.setState({ profileGeneration: 2 }) }

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('Copy Session ID follows Rename Chat and copies the ID the server lists, not an older one the app holds', async () => {
  const reads = await renderSidebar(async () => [{ ...held, claude_session_id: 'claude-after-rewind' }, listed])
  const titles = (menu('held').props.actions as Array<{ title: string }>).map(action => action.title)
  assert.deepEqual(titles.slice(1, 3), ['Rename Chat', 'Copy Session ID'])
  await copySessionId('held')
  assert.deepEqual(clipboardWrites, ['claude-after-rewind'])
  assert.deepEqual(AccessibilityInfo.__calls, ['Session ID copied'])
  assert.equal(reads.count, 1)
})

test('a chat whose row has no ID copies the ID the server lists for it', async () => {
  await renderSidebar(async () => [held, { ...listed, codex_thread_id: 'thread-listed' }])
  await copySessionId('listed')
  assert.deepEqual(clipboardWrites, ['thread-listed'])
  assert.deepEqual(AccessibilityInfo.__calls, ['Session ID copied'])
  assert.deepEqual(alerts(), [])
})

for (const [name, serverList] of [
  ['lists the chat without an ID', [{ ...held, claude_session_id: null }, listed]],
  ['no longer lists the chat', [listed]],
] as Array<[string, Session[]]>) {
  test(`a chat says it has no session ID yet and copies nothing when the server ${name}`, async () => {
    await renderSidebar(async () => serverList)
    await copySessionId('held')
    assert.deepEqual(clipboardWrites, [])
    assert.deepEqual(alerts(), [['Copy Session ID', 'This chat has no session ID yet.']])
  })
}

test('a failed read shows its reason and copies nothing', async () => {
  await renderSidebar(async () => { throw new Error('offline') })
  await copySessionId('held')
  assert.deepEqual(clipboardWrites, [])
  assert.deepEqual(alerts(), [['Could not copy session ID', 'offline']])
})

test('a read that ends after a server switch copies nothing and shows nothing', async () => {
  const reads = await renderSidebar(async () => { serverSwitch(); return [{ ...held, claude_session_id: 'claude-after-rewind' }] })
  await copySessionId('held')
  assert.equal(reads.count, 1)
  assert.deepEqual(clipboardWrites, [])
  assert.deepEqual(alerts(), [])
})

test('a read that fails after a server switch shows nothing', async () => {
  const reads = await renderSidebar(async () => { serverSwitch(); throw new Error('offline') })
  await copySessionId('held')
  assert.equal(reads.count, 1)
  assert.deepEqual(alerts(), [])
})
