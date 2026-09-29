import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import { RuntimeHealthNotice } from '../src/components/RuntimeHealth'
import { ServerError } from '../src/api/AgentServerClient'
import type { Backend, Event, RuntimeDiagnostic } from '../src/types'

const claude = (fields: Partial<RuntimeDiagnostic>): RuntimeDiagnostic => ({
  backend: 'claude', status: 'unknown', available: false, message: 'Claude Code is installed.', ...fields,
})
const authError: Event[] = [
  { id: 'e1', seq: 1, type: 'run_started', run_id: 'r1', backend: 'claude' } as Event,
  { id: 'e2', seq: 2, type: 'error', run_id: 'r1', backend: 'claude', message: 'Claude assistant error: authentication_failed' } as Event,
]
let tree: ReturnType<typeof create> | null = null
const byId = (id: string) => tree!.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0]
const texts = () => tree!.root.findAll(node => node.type === 'Text').map(node => node.props.children).flat().join(' ')
const render = async (diagnostic: RuntimeDiagnostic, { backend = 'claude', events = [] }: { backend?: Backend; events?: Event[] } = {}) => {
  if (tree) await act(async () => { tree!.unmount() })
  let refreshes = 0
  resetComponentStore({
    health: { runtimes: { [backend]: diagnostic } } as never,
    snapshots: { s1: { events } } as never,
    refreshRuntime: async () => { refreshes++ },
  } as never)
  await act(async () => { tree = create(<RuntimeHealthNotice backend={backend} sessionId="s1" />) })
  return () => refreshes
}
const submit = async (token: string) => {
  await act(async () => { byId('claude-token-input').props.onChangeText(token) })
  await act(async () => { tree!.root.findByProps({ accessibilityLabel: 'Save Claude token' }).props.onPress() })
}

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('a server without a Claude token shows the form, and a saved token refreshes status', async () => {
  const saved: string[] = []
  setTestClient({ setClaudeToken: async token => { saved.push(token); return { oauth_token_configured: true } } })
  const refreshes = await render(claude({ status: 'unauthenticated', oauth_token_configured: false }))
  assert.ok(byId('claude-token-form'))
  await submit('  sk-ant-oat01-abc  ')
  assert.deepEqual(saved, ['sk-ant-oat01-abc'])
  assert.equal(byId('claude-token-input'), undefined)
  assert.match(texts(), /Token saved/)
  assert.equal(refreshes(), 1)
})

test('the save stays confirmed while the chat still shows the missing-token error', async () => {
  setTestClient({ setClaudeToken: async () => ({ oauth_token_configured: true }) })
  const missing: Event[] = [
    { id: 'e1', seq: 1, type: 'run_started', run_id: 'r1', backend: 'claude' } as Event,
    { id: 'e2', seq: 2, type: 'error', run_id: 'r1', backend: 'claude', message: 'failed to start Claude: Claude is not authenticated on this server: CLAUDE_CODE_OAUTH_TOKEN is not set.' } as Event,
  ]
  await render(claude({ status: 'unauthenticated', oauth_token_configured: false }), { events: missing })
  // The refresh reports the saved token, as the server does.
  useAppStore.setState({
    refreshRuntime: async () => { useAppStore.setState({ health: { runtimes: { claude: claude({ oauth_token_configured: true }) } } as never }) },
  } as never)
  await submit('sk-ant-oat01-abc')
  assert.match(texts(), /Token saved/)
})

test('a rejected token surfaces the server detail and keeps the form', async () => {
  setTestClient({ setClaudeToken: async () => { throw new ServerError(400, 'Paste the token printed by `claude setup-token`.') } })
  await render(claude({ oauth_token_configured: false }))
  await submit('bad token')
  assert.ok(byId('claude-token-input'))
  assert.match(texts(), /Paste the token printed/)
})

test('a Claude authentication failure offers a new token even when one is configured', async () => {
  await render(claude({ status: 'ready', available: true, oauth_token_configured: true }), { events: authError })
  assert.ok(byId('claude-token-form'))
})

test('no form for a configured token, an older server, a missing CLI, or another provider', async () => {
  await render(claude({ status: 'ready', available: true, oauth_token_configured: true }))
  assert.equal(tree!.toJSON(), null)
  await render(claude({ status: 'unknown' }), { events: authError })
  assert.equal(byId('claude-token-form'), undefined, 'an older server has no token route')
  await render(claude({ status: 'missing', oauth_token_configured: false }))
  assert.equal(byId('claude-token-form'), undefined, 'a missing CLI needs installing, not a token')
  await render({ backend: 'codex', status: 'ready', available: true, message: 'Codex is ready.' }, { backend: 'codex', events: authError.map(event => ({ ...event, backend: 'codex' })) })
  assert.equal(byId('claude-token-form'), undefined)
})
