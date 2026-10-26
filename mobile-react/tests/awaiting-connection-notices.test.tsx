import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import { RuntimeHealthNotice } from '../src/components/RuntimeHealth'
import { WorkingDirectoryPicker } from '../src/components/WorkingDirectoryPicker'
import type { Health } from '../src/types'

let tree: ReturnType<typeof create> | null = null
const texts = () => tree!.root.findAll(node => node.type === 'Text').map(node => node.props.children).flat().join(' ')
// Without a health report the active server has not answered; the profile carries the sidebar's state.
const noHealth = (connectionState: string) => ({
  health: null,
  profiles: [{ id: 'profile-a', connectionState }],
  sessions: [{ id: 's1', backend: 'cursor', cwd: '/work' }],
  snapshots: {},
  runtime: null,
  refreshRuntime: async () => {},
}) as never
const answered = (health: Health) => ({ ...(noHealth('online') as object), health }) as never

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('the folder picker names an offline or connecting server instead of asking for an update', async () => {
  resetComponentStore(noHealth('offline'))
  await act(async () => { tree = create(<WorkingDirectoryPicker sessionId="s1" chipVisible open onOpenChange={() => {}} />) })
  assert.match(texts(), /Offline\. Available once this AgentsServer is connected\./)
  assert.doesNotMatch(texts(), /newer AgentsServer/)

  await act(async () => { resetComponentStore(noHealth('connecting')) })
  assert.match(texts(), /Connecting\. Available once this AgentsServer is connected\./)
})

test('an open folder picker lists folders once the server connects', async () => {
  const lookups: string[] = []
  setTestClient({ completeWorkingDirectory: async path => {
    lookups.push(path)
    return { input: path, base_path: path, resolved_path: path, exists: true, suggestions: [{ name: 'sub1', path: `${path}/sub1` }] }
  } } as never)
  resetComponentStore(noHealth('offline'))
  await act(async () => { tree = create(<WorkingDirectoryPicker sessionId="s1" chipVisible open onOpenChange={() => {}} />) })
  assert.deepEqual(lookups, [])

  await act(async () => { useAppStore.setState({ health: { ok: true, capabilities: { working_directory_completion: { available: true } } } as never }) })
  assert.deepEqual(lookups, ['/work'])
  assert.ok(tree!.root.findAll(node => node.props.accessibilityLabel === 'Open sub1').length > 0)
})

test('the folder picker still asks for an update when a server that answered lacks folder browsing', async () => {
  resetComponentStore(answered({ ok: true, capabilities: {} }))
  await act(async () => { tree = create(<WorkingDirectoryPicker sessionId="s1" chipVisible open onOpenChange={() => {}} />) })
  assert.match(texts(), /Folder browsing needs a newer AgentsServer\./)
  assert.doesNotMatch(texts(), /Available once/)
})

test('the Cursor notice waits for the connection instead of asking for an update', async () => {
  resetComponentStore(noHealth('offline'))
  await act(async () => { tree = create(<RuntimeHealthNotice backend="cursor" sessionId="s1" />) })
  assert.match(texts(), /Cursor status loads once this AgentsServer is connected\./)
  assert.doesNotMatch(texts(), /newer AgentsServer/)

  await act(async () => { resetComponentStore(answered({ ok: true, capabilities: {} })) })
  assert.match(texts(), /hardened Cursor backend in a newer AgentsServer/)
})
