import { createHash, randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CanvasRecord } from '../shared/types'
import { appLog } from './logger'

/** shell.html and vendor.js of one runtime version: the page shell and libraries around every compiled Canvas. */
interface CanvasRuntime {
  shell: string
  vendor: string
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
// The page is built right after the pane receives its record: the last few records stay in memory, so building it
// does not read and parse megabytes from disk again.
const RECORDS_IN_MEMORY = 8

/**
 * Canvases already downloaded, cached on disk so that opening one again, also after a restart, does not wait for
 * a remote link: the last record of each canvas with its state, and the shell and vendor of each runtime version.
 * Entries belong to a cache namespace, the server identity as in LocalCache, so every address of one server shares
 * them. The total size is bounded, the entries written longest ago go first; a lost or unreadable entry only costs
 * a download.
 */
export class CanvasCache {
  private readonly records = new Map<string, CanvasRecord>()
  // One entry per server and runtime version.
  private readonly runtimes = new Map<string, CanvasRuntime>()

  constructor(private readonly root: string, private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  async record(namespace: string, sessionId: string, name: string): Promise<CanvasRecord | null> {
    const id = [namespace, sessionId, name].join('\0')
    const inMemory = this.records.get(id)
    if (inMemory) {
      this.remember(id, inMemory)
      return inMemory
    }
    const stored = await this.read<CanvasRecord>([namespace, 'record', sessionId, name])
    if (!stored) return null
    const state = await this.read<Record<string, unknown>>([namespace, 'state', sessionId, name])
    const record = state ? { ...stored, state } : stored
    this.remember(id, record)
    return record
  }

  async putRecord(namespace: string, sessionId: string, name: string, record: CanvasRecord): Promise<void> {
    const id = [namespace, sessionId, name].join('\0')
    // A failed compile is not cached: its diagnostics can describe the host (no node, a timeout), not the source.
    if (record.diagnostics || !record.javascript) {
      this.records.delete(id)
      for (const kind of ['record', 'state']) await rm(this.path([namespace, kind, sessionId, name]), { force: true }).catch(() => undefined)
      return
    }
    this.remember(id, record)
    await this.write([namespace, 'record', sessionId, name], record)
    await this.write([namespace, 'state', sessionId, name], record.state)
  }

  /** The state has an entry of its own: a page saves it often, and the record around it can be megabytes. */
  async putState(namespace: string, sessionId: string, name: string, state: Record<string, unknown>): Promise<void> {
    const id = [namespace, sessionId, name].join('\0')
    const record = this.records.get(id)
    if (record) this.records.set(id, { ...record, state })
    await this.write([namespace, 'state', sessionId, name], state)
  }

  async runtime(namespace: string, version: string): Promise<CanvasRuntime | null> {
    const key = [namespace, 'runtime', version]
    const runtime = this.runtimes.get(key.join('\0')) ?? await this.read<CanvasRuntime>(key)
    if (runtime) this.runtimes.set(key.join('\0'), runtime)
    return runtime
  }

  async putRuntime(namespace: string, version: string, runtime: CanvasRuntime): Promise<void> {
    const key = [namespace, 'runtime', version]
    this.runtimes.set(key.join('\0'), runtime)
    await this.write(key, runtime)
  }

  /** Synchronous like LocalCache.removeServerNamespaces, so a removed profile's entries are gone before the profile. */
  removeServerNamespaces(namespaces: readonly string[]): void {
    for (const namespace of namespaces.filter(Boolean)) {
      for (const map of [this.records, this.runtimes]) {
        for (const id of map.keys()) if (id.startsWith(`${namespace}\0`)) map.delete(id)
      }
      rmSync(join(this.root, digest(namespace)), { recursive: true, force: true })
    }
  }

  private remember(id: string, record: CanvasRecord): void {
    this.records.delete(id)
    this.records.set(id, record)
    for (const oldest of this.records.keys()) {
      if (this.records.size <= RECORDS_IN_MEMORY) break
      this.records.delete(oldest)
    }
  }

  /** One directory per server, so removing a profile's entries needs no file reads. */
  private path(key: string[]): string {
    return join(this.root, digest(key[0]), `${digest(key.join('\0'))}.json`)
  }

  private async read<T>(key: string[]): Promise<T | null> {
    const path = this.path(key)
    // load-bearing: a read leaves the file's time alone, so eviction goes by when an entry was written, not used.
    // An on-access malware scanner checks a modified file again at its next open: measured 2026-11-03, 0.5 s for
    // a 1 MB runtime entry whose time a read had changed, against 3 ms unchanged.
    try {
      const stored = JSON.parse(await readFile(path, 'utf8')) as { key?: unknown; value?: T }
      if (JSON.stringify(stored.key) !== JSON.stringify(key) || stored.value === undefined) return null
      return stored.value
    } catch {
      return null
    }
  }

  private async write(key: string[], value: unknown): Promise<void> {
    const path = this.path(key)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temporary, JSON.stringify({ key, value }))
      await rename(temporary, path)
      await this.trim()
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      appLog('canvas', 'cache write failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private async trim(): Promise<void> {
    const files: Array<{ path: string; size: number; written: number }> = []
    for (const directory of await readdir(this.root)) {
      for (const name of await readdir(join(this.root, directory)).catch(() => [])) {
        const path = join(this.root, directory, name)
        const info = await stat(path).catch(() => null)
        if (info?.isFile()) files.push({ path, size: info.size, written: info.mtimeMs })
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files.sort((a, b) => a.written - b.written)) {
      if (total <= this.maxBytes) break
      await rm(file.path, { force: true })
      total -= file.size
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}
