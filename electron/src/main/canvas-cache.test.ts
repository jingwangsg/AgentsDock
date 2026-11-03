// @vitest-environment node
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasRecord } from '../shared/types'
import { CanvasCache } from './canvas-cache'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentsdock-canvas-cache-'))
  roots.push(root)
  return root
}

function record(revision: number, javascript = `var report = ${revision}`): CanvasRecord {
  return { name: 'report', path: '/state/canvases/chat/report.canvas.tsx', revision, updated_at: 't', source: 'source', javascript, diagnostics: null, runtime_version: 'v1', state: { filter: 'all' } }
}

function files(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

describe('CanvasCache', () => {
  it('keeps records and runtimes on disk under the server identity, so a new instance reads them back', async () => {
    const root = cacheRoot()
    const first = new CanvasCache(root)
    await first.putRecord('server-a', 'chat', 'report', record(1))
    await first.putRuntime('server-a', 'v1', { shell: '<html>', vendor: 'vendor()' })

    const restarted = new CanvasCache(root)
    expect(await restarted.record('server-a', 'chat', 'report')).toEqual(record(1))
    expect(await restarted.runtime('server-a', 'v1')).toEqual({ shell: '<html>', vendor: 'vendor()' })
    // Another server, chat, canvas or runtime version is another entry.
    expect(await restarted.record('server-b', 'chat', 'report')).toBeNull()
    expect(await restarted.record('server-a', 'other-chat', 'report')).toBeNull()
    expect(await restarted.record('server-a', 'chat', 'other')).toBeNull()
    expect(await restarted.runtime('server-a', 'v2')).toBeNull()
  })

  it('keeps the state in an entry of its own, so a saved state does not rewrite the record', async () => {
    const root = cacheRoot()
    const cache = new CanvasCache(root)
    await cache.putRecord('server-a', 'chat', 'report', record(1))
    const recordFile = files(root).map(file => [file, statSync(file).size] as const).sort((a, b) => b[1] - a[1])[0][0]
    const past = new Date(Date.now() - 60_000)
    utimesSync(recordFile, past, past)
    const written = statSync(recordFile).mtimeMs

    await cache.putState('server-a', 'chat', 'report', { filter: 'mine' })

    expect(statSync(recordFile).mtimeMs).toBe(written)
    expect(await cache.record('server-a', 'chat', 'report')).toEqual({ ...record(1), state: { filter: 'mine' } })
    expect(await new CanvasCache(root).record('server-a', 'chat', 'report')).toEqual({ ...record(1), state: { filter: 'mine' } })
  })

  it('drops the entry of a canvas whose latest record did not compile', async () => {
    const root = cacheRoot()
    const cache = new CanvasCache(root)
    await cache.putRecord('server-a', 'chat', 'report', record(1))
    await cache.putRecord('server-a', 'chat', 'report', { ...record(2, ''), diagnostics: 'Canvas compiler timed out after 180s.' })

    expect(await cache.record('server-a', 'chat', 'report')).toBeNull()
    expect(await new CanvasCache(root).record('server-a', 'chat', 'report')).toBeNull()
  })

  it('removes the entries written longest ago beyond its size limit', async () => {
    const root = cacheRoot()
    const big = 'x'.repeat(4000)
    const cache = new CanvasCache(root, 10_000)
    await cache.putRecord('server-a', 'chat', 'old', { ...record(1, big), name: 'old' })
    const past = new Date(Date.now() - 60_000)
    for (const file of files(root)) utimesSync(file, past, past)
    await cache.putRecord('server-a', 'chat', 'newer', { ...record(1, big), name: 'newer' })

    await cache.putRecord('server-a', 'chat', 'newest', { ...record(1, big), name: 'newest' })

    const reread = new CanvasCache(root)
    expect(await reread.record('server-a', 'chat', 'old')).toBeNull()
    expect(await reread.record('server-a', 'chat', 'newer')).not.toBeNull()
    expect(await reread.record('server-a', 'chat', 'newest')).not.toBeNull()
  })

  it('forgets every entry of a removed server profile', async () => {
    const root = cacheRoot()
    const cache = new CanvasCache(root)
    await cache.putRecord('server-a', 'chat', 'report', record(1))
    await cache.putRuntime('server-a', 'v1', { shell: '<html>', vendor: 'vendor()' })
    await cache.putRecord('server-b', 'chat', 'report', record(1))

    cache.removeServerNamespaces(['server-a', ''])

    expect(await cache.record('server-a', 'chat', 'report')).toBeNull()
    expect(await cache.runtime('server-a', 'v1')).toBeNull()
    expect(await cache.record('server-b', 'chat', 'report')).toEqual(record(1))
    // server-b's record and state.
    expect(files(root)).toHaveLength(2)
  })
})
