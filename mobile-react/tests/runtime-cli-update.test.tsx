import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { resetComponentStore, setTestClient, useAppStore } from './component-mocks/app-store'
import { RuntimeHealthPanel } from '../src/components/RuntimeHealth'
import { ServerError } from '../src/api/AgentServerClient'
import type { RuntimeDiagnostic } from '../src/types'

const ready = (backend: 'claude' | 'codex', fields: Partial<RuntimeDiagnostic> = {}): RuntimeDiagnostic => ({
  backend, status: 'ready', available: true, installed: true, message: 'Installed.', version: '1.0.0', checked_at: '2026-09-29T10:00:00Z', ...fields,
})
let tree: ReturnType<typeof create> | null = null
const texts = () => tree!.root.findAll(node => node.type === 'Text').map(node => node.props.children).flat().join(' ')
const render = async (runtimes: Record<string, RuntimeDiagnostic>, updatable = true) => {
  resetComponentStore({ health: { runtimes, capabilities: { runtime_cli_update_v1: { available: updatable } } } as never } as never)
  await act(async () => { tree = create(<RuntimeHealthPanel />) })
}
const press = async (label: string) => {
  await act(async () => { await tree!.root.findByProps({ accessibilityLabel: label }).props.onPress() })
}

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('Update CLI runs the update on the server and shows its result and the new version', async () => {
  const updated: string[] = []
  setTestClient({ updateRuntimeCli: async backend => {
    updated.push(backend)
    return { output: 'Updating…\nCodex updated to 0.160.0', diagnostic: ready('codex', { version: 'codex-cli 0.160.0', checked_at: '2026-09-29T10:05:00Z' }) }
  } })
  await render({ claude: ready('claude'), codex: ready('codex') })

  await press('Update Codex CLI')

  assert.deepEqual(updated, ['codex'])
  assert.match(texts(), /Codex updated to 0\.160\.0/)
  assert.match(texts(), /codex-cli 0\.160\.0/)
  assert.equal(useAppStore.getState().health?.runtimes?.codex?.version, 'codex-cli 0.160.0')
})

test('a server without the update route offers no update', async () => {
  await render({ claude: ready('claude'), codex: ready('codex') }, false)
  assert.equal(tree!.root.findAll(node => node.props.accessibilityLabel === 'Update Claude Code CLI').length, 0)
})

test('a failed update shows the server detail, and a missing CLI offers no update', async () => {
  setTestClient({ updateRuntimeCli: async () => { throw new ServerError(500, '`claude update` exited with 3: EACCES') } })
  await render({ claude: ready('claude'), codex: ready('codex', { status: 'missing', installed: false }) })

  assert.equal(tree!.root.findAll(node => node.props.accessibilityLabel === 'Update Codex CLI').length, 0)
  await press('Update Claude Code CLI')

  assert.match(texts(), /exited with 3: EACCES/)
})
