import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { resetComponentStore, useAppStore } from './component-mocks/app-store'
import { RuntimeHealthNotice } from '../src/components/RuntimeHealth'
import { WorkingDirectoryPicker } from '../src/components/WorkingDirectoryPicker'
import type { Health } from '../src/types'

let tree: ReturnType<typeof create> | null = null
const texts = () => tree!.root.findAll(node => node.type === 'Text').map(node => node.props.children).flat().join(' ')
// A null health report means the server has not answered; connectionState is what the server list shows.
const storeState = (connectionState: string, health: Health | null = null) => ({
  health,
  activeProfileId: 'profile-a',
  profiles: [{ id: 'profile-a', connectionState }],
  sessions: [{ id: 's1', backend: 'cursor', cwd: '/work' }],
  snapshots: {},
  runtime: null,
  refreshRuntime: async () => {},
}) as never

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('the folder picker names an offline or connecting server instead of asking for an update', async () => {
  resetComponentStore(storeState('offline'))
  await act(async () => { tree = create(<WorkingDirectoryPicker sessionId="s1" chipVisible open onOpenChange={() => {}} />) })
  assert.match(texts(), /Offline\. Available once this AgentsServer is connected\./)
  assert.doesNotMatch(texts(), /newer AgentsServer/)

  await act(async () => { useAppStore.setState({ profiles: [{ id: 'profile-a', connectionState: 'connecting' }] } as never) })
  assert.match(texts(), /Connecting\. Available once this AgentsServer is connected\./)
})

test('the folder picker still asks for an update when a server that answered lacks folder browsing', async () => {
  resetComponentStore(storeState('online', { ok: true, capabilities: {} }))
  await act(async () => { tree = create(<WorkingDirectoryPicker sessionId="s1" chipVisible open onOpenChange={() => {}} />) })
  assert.match(texts(), /Folder browsing needs a newer AgentsServer\./)
  assert.doesNotMatch(texts(), /Available once/)
})

test('the Cursor notice waits for the connection instead of asking for an update', async () => {
  resetComponentStore(storeState('offline'))
  await act(async () => { tree = create(<RuntimeHealthNotice backend="cursor" sessionId="s1" />) })
  assert.match(texts(), /Cursor status loads once this AgentsServer is connected\./)
  assert.doesNotMatch(texts(), /newer AgentsServer/)

  await act(async () => { useAppStore.setState({ health: { ok: true, capabilities: {} } } as never) })
  assert.match(texts(), /hardened Cursor backend in a newer AgentsServer/)
})
