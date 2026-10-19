import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { resetComponentStore } from './component-mocks/app-store'
import { NewAgentSheet, type NewAgentHosts } from '../src/components/NewAgentSheet'
import type { CrossServerChats, NewAgentSettings } from '../src/types'

let tree: ReturnType<typeof create> | null = null
const byId = (id: string) => tree!.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0]
const press = async (id: string) => { await act(async () => { byId(id).props.onPress() }) }

const render = async (servers: CrossServerChats[]) => {
  resetComponentStore({} as never)
  const confirmed: NewAgentSettings[] = []
  const hosts: NewAgentHosts = { servers, localTag: '' }
  await act(async () => {
    tree = create(<NewAgentSheet
      hosts={hosts} backends={['claude', 'codex']} backend="claude" model={null} effort={null} folder="Research"
      defaultCwd="/home/me" runtime={null} onCancel={() => {}} onConfirm={settings => { confirmed.push(settings) }} onDidDismiss={() => {}}
    />)
  })
  return confirmed
}

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('the working directory starts empty with this server\'s home directory as its placeholder', async () => {
  const confirmed = await render([])
  assert.equal(byId('new-agent-cwd').props.value, '')
  assert.equal(byId('new-agent-cwd').props.placeholder, '/home/me')
  await press('new-agent-confirm')
  // Empty means the server's home directory: the server's default for a chat created without one.
  assert.equal(confirmed[0].cwd, '')
})

test('another server shows its own home directory, and a typed directory is sent trimmed', async () => {
  const confirmed = await render([
    { server_identity: 'srv-gpu', name: 'gpu-box', chats: [], default_cwd: '/home/gpu' },
    { server_identity: 'srv-old', name: 'old-box', chats: [] },
  ])
  await press('new-agent-server-srv-gpu')
  assert.equal(byId('new-agent-cwd').props.placeholder, '/home/gpu')
  // A hub older than the field names no home directory.
  await press('new-agent-server-srv-old')
  assert.equal(byId('new-agent-cwd').props.placeholder, 'Server home directory')
  await press('new-agent-server-srv-gpu')
  await act(async () => { byId('new-agent-cwd').props.onChangeText('  /data/lab  ') })
  await press('new-agent-confirm')
  assert.deepEqual(confirmed, [{ backend: 'claude', model: null, effort: null, server_identity: 'srv-gpu', folder: 'Research', cwd: '/data/lab' }])
})
