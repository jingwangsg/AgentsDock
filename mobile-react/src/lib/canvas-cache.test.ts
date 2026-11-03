// node scripts/run-history-tests.mjs src/lib/canvas-cache.test.ts --native-mocks
import assert from 'node:assert/strict'
import { mockCacheFiles } from 'expo-file-system'
import type { CanvasRecord } from '../types'
import { cacheCanvas, cacheCanvasRuntime, cacheCanvasState, cachedCanvas, cachedCanvasRuntime, sameCanvasState } from './canvas-cache'

const record = (revision: number, javascript = `var report = ${revision}`): CanvasRecord => ({
  name: 'report', path: '/state/canvases/chat/report.canvas.tsx', revision, updated_at: 't', source: 'source',
  javascript, diagnostics: null, runtime_version: 'v1', state: { filter: 'all' },
})

// --- cached per server identity, chat and canvas; runtimes per server identity and version
{
  mockCacheFiles.clear()
  cacheCanvas('server-a', 'chat', 'report', record(1))
  cacheCanvasRuntime('server-a', 'v1', { shell: '<html>', vendor: 'vendor()' })
  assert.deepEqual(await cachedCanvas('server-a', 'chat', 'report'), record(1))
  assert.deepEqual(await cachedCanvasRuntime('server-a', 'v1'), { shell: '<html>', vendor: 'vendor()' })
  assert.equal(await cachedCanvas('server-b', 'chat', 'report'), null, 'another server identity has its own entries')
  assert.equal(await cachedCanvas('server-a', 'other-chat', 'report'), null)
  assert.equal(await cachedCanvasRuntime('server-a', 'v2'), null)
}

// --- a saved state goes to its own entry and leaves the record's file alone
{
  mockCacheFiles.clear()
  cacheCanvas('server-a', 'chat', 'report', record(1))
  const recordFile = [...mockCacheFiles.values()].sort((a, b) => b.text.length - a.text.length)[0]
  const recordText = recordFile.text
  cacheCanvasState('server-a', 'chat', 'report', { filter: 'mine' })
  assert.equal(recordFile.text, recordText)
  assert.deepEqual(await cachedCanvas('server-a', 'chat', 'report'), { ...record(1), state: { filter: 'mine' } })
}

// --- a canvas whose latest record did not compile has no cached copy
{
  mockCacheFiles.clear()
  cacheCanvas('server-a', 'chat', 'report', record(1))
  cacheCanvas('server-a', 'chat', 'report', { ...record(2, ''), diagnostics: 'Canvas compiler timed out after 180s.' })
  assert.equal(await cachedCanvas('server-a', 'chat', 'report'), null)
}

// --- an unreadable entry is a miss
{
  mockCacheFiles.clear()
  cacheCanvas('server-a', 'chat', 'report', record(1))
  for (const file of mockCacheFiles.values()) file.text = '{"key":'
  assert.equal(await cachedCanvas('server-a', 'chat', 'report'), null)
}

// --- the entries written longest ago go first beyond 64 MiB
{
  mockCacheFiles.clear()
  const big = 'x'.repeat(30 * 1024 * 1024)
  cacheCanvas('server-a', 'chat', 'old', { ...record(1, big), name: 'old' })
  for (const file of mockCacheFiles.values()) file.modified -= 60_000
  cacheCanvas('server-a', 'chat', 'newer', { ...record(1, big), name: 'newer' })
  cacheCanvas('server-a', 'chat', 'newest', { ...record(1, big), name: 'newest' })
  assert.equal(await cachedCanvas('server-a', 'chat', 'old'), null)
  assert.ok(await cachedCanvas('server-a', 'chat', 'newer'))
  assert.ok(await cachedCanvas('server-a', 'chat', 'newest'))
}

// --- states compare without key order: the server stores them sorted, a page reports its own order
{
  assert.equal(sameCanvasState({ tab: 1, filter: { region: 'eu', metric: 'loss' } }, { filter: { metric: 'loss', region: 'eu' }, tab: 1 }), true)
  assert.equal(sameCanvasState({ runs: [2, 1] }, { runs: [1, 2] }), false, 'an array keeps its order')
  assert.equal(sameCanvasState(undefined, {}), true)
  assert.equal(sameCanvasState({ filter: 'all' }, { filter: 'mine' }), false)
}

console.log('canvas cache tests passed')
