import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { resetComponentStore, setTestClient } from './component-mocks/app-store'
import { RuntimeHealthNotice } from '../src/components/RuntimeHealth'
import type { Event, RuntimeDiagnostic } from '../src/types'

const codex: RuntimeDiagnostic = { backend: 'codex', status: 'ready', available: true, message: 'Codex is installed and authenticated.' }
const held: Event[] = [
  { id: 'e1', seq: 1, type: 'turn_started', run_id: 'r1', backend: 'codex' } as Event,
  { id: 'e2', seq: 2, type: 'error', run_id: 'r1', backend: 'codex', message: "409: Another Codex process still holds this chat's thread: a `codex resume` left open on the server, or an app-server that has not finished unloading it. Close it or wait, then retry." } as Event,
]
let tree: ReturnType<typeof create> | null = null
const byId = (id: string) => tree!.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0]
const texts = () => tree!.root.findAll(node => node.type === 'Text').map(node => node.props.children).flat().join(' ')

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('a Codex thread held by another process offers to end the holder, then asks for a resend', async () => {
  const released: string[] = []
  setTestClient({ killCodexWriters: async sessionId => { released.push(sessionId); return { killed: [7174] } } })
  resetComponentStore({ health: { runtimes: { codex } } as never, snapshots: { s1: { events: held } } as never, refreshRuntime: async () => {} } as never)
  await act(async () => { tree = create(<RuntimeHealthNotice backend="codex" sessionId="s1" />) })
  await act(async () => { byId('codex-kill-writers').props.onPress() })
  assert.deepEqual(released, ['s1'])
  assert.match(texts(), /ended 1 Codex process/)
})

test('an ordinary Codex error offers no release', async () => {
  const plain: Event[] = [held[0], { ...held[1], message: '409: wait for the active Codex turn to finish' } as Event]
  resetComponentStore({ health: { runtimes: { codex } } as never, snapshots: { s1: { events: plain } } as never, refreshRuntime: async () => {} } as never)
  await act(async () => { tree = create(<RuntimeHealthNotice backend="codex" sessionId="s1" />) })
  assert.equal(byId('codex-kill-writers'), undefined)
})
