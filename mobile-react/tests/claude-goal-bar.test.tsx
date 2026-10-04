import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { ClaudeGoalBar } from '../src/components/ClaudeGoalBar'
import { ClaudeRuntimeProvider } from '../src/components/ClaudeRuntimeContext'
import { CLAUDE_INTERACTIVE_CLIENT_CAPABILITY } from '../src/lib/claude-controls'
import type { ClaudeGoal, ClaudeRuntimeSnapshot, Health, Session } from '../src/types'
import { resetComponentStore, setTestClient } from './component-mocks/app-store'
import { Alert } from './component-mocks/react-native'

const health = { ok: true, capabilities: { claude_controls: { available: true, version: 1, interactive_client_capability: CLAUDE_INTERACTIVE_CLIENT_CAPABILITY } } } as unknown as Health
const session = { id: 'chat-a', backend: 'claude', claude_session_id: 'claude-a' } as Session
const goal: ClaudeGoal = { condition: '最小化sim和real的gap', status: 'active', set_at: Date.now() - 65_000, iterations: 3 }
function runtime(value: ClaudeGoal | null, status: 'idle' | 'active' = 'idle'): ClaudeRuntimeSnapshot {
  return { available: true, transport: 'agent-sdk', interactive_capability: CLAUDE_INTERACTIVE_CLIENT_CAPABILITY, session_loaded: true, status: { type: status }, pending_interactions: [], goal: value, features: { goals: true } } as ClaudeRuntimeSnapshot
}
const mounted: ReactTestRenderer[] = []
const calls = { edit: 0, clear: 0 }
async function mount(snapshot: ClaudeRuntimeSnapshot) {
  setTestClient({ claudeRuntime: async () => snapshot })
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(<ClaudeRuntimeProvider sessionId="chat-a"><ClaudeGoalBar onEdit={() => { calls.edit++ }} onClear={() => { calls.clear++ }} /></ClaudeRuntimeProvider>)
  })
  mounted.push(tree)
  return tree
}
const nodes = (tree: ReactTestRenderer, id: string) => tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)
const texts = (tree: ReactTestRenderer) => tree.root.findAll(node => node.type === 'Text').map(node => node.props.children).flat().join(' ')

beforeEach(() => {
  Alert.__reset()
  calls.edit = 0
  calls.clear = 0
  resetComponentStore({ health, sessions: [session], selectedSessionId: 'chat-a', switchingProfileId: null, connected: true } as never)
})
afterEach(async () => { for (const tree of mounted.splice(0)) await act(async () => tree.unmount()) })

test('an active Claude goal stays visible with its condition, and Clear asks first', async () => {
  const tree = await mount(runtime(goal))
  assert.equal(nodes(tree, 'claude-goal-bar').length, 1)
  assert.match(texts(tree), /最小化sim和real的gap/)
  assert.match(texts(tree), /3 iterations · 01:0\d/)
  await act(async () => { nodes(tree, 'claude-goal-edit')[0].props.onPress() })
  assert.equal(calls.edit, 1)
  await act(async () => { nodes(tree, 'claude-goal-clear')[0].props.onPress() })
  assert.equal(Alert.__calls.length, 1)
  assert.equal(Alert.__calls[0].title, 'Clear Claude goal?')
  const cancel = Alert.__calls[0].buttons?.find(button => button.style === 'cancel')
  assert.ok(cancel)
  await act(async () => cancel.onPress?.())
  assert.equal(calls.clear, 0)
  await act(async () => { nodes(tree, 'claude-goal-clear')[0].props.onPress() })
  await act(async () => Alert.__calls[1].buttons?.find(button => button.style === 'destructive')?.onPress?.())
  assert.equal(calls.clear, 1)
})

test('while Claude is working, clearing is offered as Clear & stop and the pencil still opens the editor', async () => {
  const tree = await mount(runtime(goal, 'active'))
  assert.equal(nodes(tree, 'claude-goal-clear')[0].props.accessibilityLabel, 'Clear the goal and stop current work')
  assert.match(texts(tree), /Clear & stop/)
  // The editor handles the running goal (stop, then start the edited condition); the pencil must not go dead.
  assert.equal(nodes(tree, 'claude-goal-edit')[0].props.disabled, false)
  await act(async () => { nodes(tree, 'claude-goal-edit')[0].props.onPress() })
  assert.equal(calls.edit, 1)
  await act(async () => { nodes(tree, 'claude-goal-clear')[0].props.onPress() })
  assert.equal(Alert.__calls[0].title, 'Clear the goal and stop current work?')
})

test('an achieved or cleared goal shows no bar', async () => {
  for (const status of ['achieved', 'cleared'] as const) {
    const tree = await mount(runtime({ ...goal, status }))
    assert.equal(nodes(tree, 'claude-goal-bar').length, 0)
  }
})
