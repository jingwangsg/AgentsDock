// Canvases already downloaded, kept in the app's cache directory so that opening one again, also after the app
// restarted, does not wait for a remote link. Port of electron/src/main/canvas-cache.ts: the last record of each
// canvas and the shell and vendor of each runtime version, under the server identity, so every address of one
// server shares them. The total size is bounded, the entries written longest ago go first; the system may clear
// the directory as well, and a lost or unreadable entry only costs a download.
import { Directory, File, Paths } from 'expo-file-system'
import type { CanvasRecord, CanvasSummary } from '../types'

/** shell.html and vendor.js of one runtime version: the frame around every compiled Canvas of a server. */
export interface CanvasRuntime {
  shell: string
  vendor: string
}

const MAX_BYTES = 64 * 1024 * 1024

export function cachedCanvas(serverIdentity: string, sessionId: string, name: string): Promise<CanvasRecord | null> {
  return read([serverIdentity, 'record', sessionId, name])
}

export function keepCanvas(serverIdentity: string, sessionId: string, name: string, record: CanvasRecord): void {
  const key = [serverIdentity, 'record', sessionId, name]
  // A failed compile is not kept: its diagnostics can describe the host (no node, a timeout), not the source.
  if (record.diagnostics || !record.javascript) remove(key)
  else write(key, record)
}

export function cachedCanvasRuntime(serverIdentity: string, version: string): Promise<CanvasRuntime | null> {
  return read([serverIdentity, 'runtime', version])
}

export function keepCanvasRuntime(serverIdentity: string, version: string, runtime: CanvasRuntime): void {
  write([serverIdentity, 'runtime', version], runtime)
}

/** A kept record whose revision and runtime version the server still lists has the current bundle; only its state can differ. */
export function keptCanvasIsCurrent(kept: CanvasRecord, list: { canvases: CanvasSummary[]; capability?: { runtime_version?: string | null } }): boolean {
  return list.canvases.find(canvas => canvas.name === kept.name)?.revision === kept.revision
    && list.capability?.runtime_version === kept.runtime_version
}

function entry(key: string[]): File {
  const directory = new Directory(Paths.cache, 'agentsdock-canvases')
  directory.create({ idempotent: true, intermediates: true })
  return new File(directory, `${digest(key.join('\0'))}.json`)
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
    // Nothing kept, nothing to remove.
  }
}

/** File name for a key: the stored key is compared on read, so a collision only loses an entry. */
function digest(value: string): string {
  let first = 0xdeadbeef
  let second = 0x41c6ce57
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 2654435761)
    second = Math.imul(second ^ code, 1597334677)
  }
  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909)
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909)
  return (second >>> 0).toString(16).padStart(8, '0') + (first >>> 0).toString(16).padStart(8, '0')
}
