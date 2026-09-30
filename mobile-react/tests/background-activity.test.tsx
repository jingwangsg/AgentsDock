import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { Alert } from './component-mocks/react-native'
import { resetComponentStore, setTestClient } from './component-mocks/app-store'
import { BackgroundActivityButton } from '../src/components/BackgroundActivity'
import type { BackgroundActivityItem } from '../src/lib/background-activity'
import { useAppStore } from './component-mocks/app-store'

const shell: BackgroundActivityItem = { id: 'b1', command: 'sleep 600' }
let tree: ReturnType<typeof create> | null = null
const texts = () => tree!.root.findAll(node => node.type === 'Text').map(node => node.props.children).flat().join(' ')
afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('the header chip lists background terminals, stops one after confirmation and reloads when a turn starts', async () => {
  let items = [shell]
  const stopped: string[] = []
  setTestClient({ backgroundActivity: async () => items, stopBackgroundActivity: async (_sessionId, id) => { stopped.push(id); items = []; return true } })
  resetComponentStore({ sessions: [{ id: 'chat-a', title: 'Research', backend: 'codex' }] as never, health: { ok: true, capabilities: { background_activity_v1: { available: true } } } as never })
  await act(async () => { tree = create(<BackgroundActivityButton sessionId="chat-a" />) })

  await act(async () => { tree!.root.findByProps({ testID: 'background-activity' }).props.onPress() })
  assert.match(texts(), /sleep 600/)
  Alert.__reset()
  await act(async () => { tree!.root.findByProps({ accessibilityLabel: 'Stop sleep 600' }).props.onPress() })
  assert.deepEqual(stopped, [], 'Stop asks first')
  await act(async () => { Alert.__calls.at(-1)!.buttons!.find(button => button.text === 'Stop')!.onPress!() })
  assert.deepEqual(stopped, ['b1'])
  assert.equal(tree!.root.findAll(node => node.props.testID === 'background-activity').length, 0, 'nothing left, no chip')

  items = [{ id: 'b2', command: 'npm run watch' }]
  await act(async () => { useAppStore.setState({ activeSessionIds: new Set(['chat-a']) }) })
  assert.equal(tree!.root.findAll(node => node.props.testID === 'background-activity').length, 1)
})

test('stays hidden, without asking, for a Claude chat and on a server without it', async () => {
  let asked = false
  setTestClient({ backgroundActivity: async () => { asked = true; return [shell] } })
  for (const [backend, capabilities] of [['claude', { background_activity_v1: { available: true } }], ['codex', {}]] as const) {
    resetComponentStore({ sessions: [{ id: 'chat-a', title: 'Research', backend }] as never, health: { ok: true, capabilities } as never })
    await act(async () => { tree = create(<BackgroundActivityButton sessionId="chat-a" />) })
    assert.equal(tree!.toJSON(), null)
    await act(async () => { tree!.unmount() })
    tree = null
  }
  assert.equal(asked, false)
})
