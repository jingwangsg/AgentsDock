// Canvases already downloaded, cached in the app's cache directory so that opening one again, also after the app
// restarted, does not wait for a remote link. Port of electron/src/main/canvas-cache.ts: the last record of each
// canvas with its state in an entry of its own, and the shell and vendor of each runtime version, under the server
// identity, so every address of one server shares them. Unlike the desktop it keeps nothing in memory and does not
// remove a removed profile's entries; the system may clear the directory. The total size is bounded, lower than on
// the desktop for a phone's storage, and the entries written longest ago go first. A lost or unreadable entry only
// costs a download.
import { Directory, File, Paths } from 'expo-file-system'
import type { CanvasRecord } from '../types'
import { fileViewerCacheKey } from './file-viewer'

/** shell.html and vendor.js of one runtime version: the page shell and libraries around every compiled Canvas. */
interface CanvasRuntime {
  shell: string
  vendor: string
}

const MAX_BYTES = 64 * 1024 * 1024

export async function cachedCanvas(serverIdentity: string, sessionId: string, name: string): Promise<CanvasRecord | null> {
  const record = await read<CanvasRecord>([serverIdentity, 'record', sessionId, name])
  const state = record && await read<Record<string, unknown>>([serverIdentity, 'state', sessionId, name])
  return record && state ? { ...record, state } : record
}

export function cacheCanvas(serverIdentity: string, sessionId: string, name: string, record: CanvasRecord): void {
  // A failed compile is not cached: its diagnostics can describe the host (no node, a timeout), not the source.
  if (record.diagnostics || !record.javascript) {
    remove([serverIdentity, 'record', sessionId, name])
    return
  }
  write([serverIdentity, 'record', sessionId, name], record)
  write([serverIdentity, 'state', sessionId, name], record.state)
}

/** The state has an entry of its own: a page saves it often, and the record around it can be megabytes. */
export function cacheCanvasState(serverIdentity: string, sessionId: string, name: string, state: Record<string, unknown>): void {
  write([serverIdentity, 'state', sessionId, name], state)
}

export function cachedCanvasRuntime(serverIdentity: string, version: string): Promise<CanvasRuntime | null> {
  return read([serverIdentity, 'runtime', version])
}

export function cacheCanvasRuntime(serverIdentity: string, version: string, runtime: CanvasRuntime): void {
  write([serverIdentity, 'runtime', version], runtime)
}

/** Compared without key order: the server stores a state with sorted keys, a page reports its keys in its own order. */
export function sameCanvasState(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const sorted = (value: unknown): string => JSON.stringify(value ?? {}, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0))
    : item)
  return sorted(a) === sorted(b)
}

function entry(key: string[]): File {
  const directory = new Directory(Paths.cache, 'agentsdock-canvases')
  directory.create({ idempotent: true, intermediates: true })
  // The stored key is compared on read, so a name collision only loses an entry.
  return new File(directory, `${fileViewerCacheKey(key.join('\0'))}.json`)
}

async function read<T>(key: string[]): Promise<T | null> {
  try {
    const file = entry(key)
    if (!file.exists) return null
    const stored = JSON.parse(await file.text()) as { key?: unknown; value?: T }
    return JSON.stringify(stored.key) === JSON.stringify(key) && stored.value !== undefined ? stored.value : null
  } catch {
    return null
  }
}

function write(key: string[], value: unknown): void {
  try {
    entry(key).write(JSON.stringify({ key, value }))
    const files = new Directory(Paths.cache, 'agentsdock-canvases').list().filter((item): item is File => item instanceof File)
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files.sort((a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0))) {
      if (total <= MAX_BYTES) break
      total -= file.size
      file.delete()
    }
  } catch {
    // A full or unwritable cache directory only costs the next open its download.
  }
}

function remove(key: string[]): void {
  try {
    const file = entry(key)
    if (file.exists) file.delete()
  } catch {
    // A copy that could not be deleted is still checked against the server's list at the next open.
  }
}
