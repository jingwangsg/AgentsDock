// node scripts/run-history-tests.mjs src/lib/canvas-cache.test.ts --native-mocks
import assert from 'node:assert/strict'
import { mockCacheFiles } from 'expo-file-system'
import type { CanvasRecord } from '../types'
import { cachedCanvas, cachedCanvasRuntime, keepCanvas, keepCanvasRuntime, keptCanvasIsCurrent } from './canvas-cache'

const record = (revision: number, javascript = `var report = ${revision}`): CanvasRecord => ({
  name: 'report', path: '/state/canvases/chat/report.canvas.tsx', revision, updated_at: 't', source: 'source',
  javascript, diagnostics: null, runtime_version: 'v1', state: { filter: 'all' },
})

// --- kept per server identity, chat and canvas; runtimes per server identity and version
{
  keepCanvas('server-a', 'chat', 'report', record(1))
  keepCanvasRuntime('server-a', 'v1', { shell: '<html>', vendor: 'vendor()' })
  assert.deepEqual(await cachedCanvas('server-a', 'chat', 'report'), record(1))
  assert.deepEqual(await cachedCanvasRuntime('server-a', 'v1'), { shell: '<html>', vendor: 'vendor()' })
  assert.equal(await cachedCanvas('server-b', 'chat', 'report'), null, 'another server identity has its own entries')
  assert.equal(await cachedCanvas('server-a', 'other-chat', 'report'), null)
  assert.equal(await cachedCanvasRuntime('server-a', 'v2'), null)
}

// --- a canvas whose latest record did not compile has no kept copy
{
  keepCanvas('server-a', 'chat', 'report', { ...record(2, ''), diagnostics: 'Canvas compiler timed out after 180s.' })
  assert.equal(await cachedCanvas('server-a', 'chat', 'report'), null)
}

// --- an unreadable entry is a miss
{
  keepCanvas('server-a', 'chat', 'report', record(1))
  for (const file of mockCacheFiles.values()) file.text = '{"key":'
  assert.equal(await cachedCanvas('server-a', 'chat', 'report'), null)
}

// --- the entries written longest ago go first beyond 64 MiB
{
  mockCacheFiles.clear()
  const big = 'x'.repeat(30 * 1024 * 1024)
  keepCanvas('server-a', 'chat', 'old', { ...record(1, big), name: 'old' })
  for (const file of mockCacheFiles.values()) file.modified -= 60_000
  keepCanvas('server-a', 'chat', 'newer', { ...record(1, big), name: 'newer' })
  keepCanvas('server-a', 'chat', 'newest', { ...record(1, big), name: 'newest' })
  assert.equal(await cachedCanvas('server-a', 'chat', 'old'), null)
  assert.ok(await cachedCanvas('server-a', 'chat', 'newer'))
  assert.ok(await cachedCanvas('server-a', 'chat', 'newest'))
}

// --- a kept copy is current while the server lists its revision under the same runtime version
{
  const list = (revision: number, runtimeVersion = 'v1') => ({
    canvases: [{ name: 'report', path: '/state/canvases/chat/report.canvas.tsx', revision, size: 6, updated_at: 't' }],
    capability: { runtime_version: runtimeVersion },
  })
  assert.equal(keptCanvasIsCurrent(record(1), list(1)), true)
  assert.equal(keptCanvasIsCurrent(record(1), list(2)), false, 'the agent saved a new revision')
  assert.equal(keptCanvasIsCurrent(record(1), list(1, 'v2')), false, 'the server compiles with another runtime')
  assert.equal(keptCanvasIsCurrent(record(1), { canvases: [] }), false, 'the canvas is gone')
}

console.log('canvas cache tests passed')
