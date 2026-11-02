import { createHash, randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CanvasRecord } from '../shared/types'
import { appLog } from './logger'

/** shell.html and vendor.js of one runtime version: the frame around every compiled Canvas of a server. */
export interface CanvasRuntime {
  shell: string
  vendor: string
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
// The page is built right after the pane receives its record; the last few stay in memory for that.
const RECENT_RECORDS = 8

/**
 * Canvases already downloaded, kept on disk so that opening one again, also after a restart, does not wait
 * for a remote link: the last record of each canvas, and the shell and vendor of each runtime version.
 * Entries belong to a server identity, so every address of one server shares them. The total size is
 * bounded, least recently used first; a lost or unreadable entry only costs a download.
 */
export class CanvasCache {
  private readonly records = new Map<string, CanvasRecord>()
  private readonly runtimes = new Map<string, CanvasRuntime>()

  constructor(private readonly root: string, private readonly maxBytes = DEFAULT_MAX_BYTES) {}

  async record(namespace: string, sessionId: string, name: string): Promise<CanvasRecord | null> {
    const key = [namespace, 'record', sessionId, name]
    const id = key.join('\0')
    const recent = this.records.get(id) ?? await this.read<CanvasRecord>(key)
    if (recent) this.remember(id, recent)
    return recent
  }

  async putRecord(namespace: string, sessionId: string, name: string, record: CanvasRecord): Promise<void> {
    const key = [namespace, 'record', sessionId, name]
    const id = key.join('\0')
    // A failed compile is not kept: its diagnostics can describe the host (no node, a timeout), not the source.
    if (record.diagnostics || !record.javascript) {
      this.records.delete(id)
      await rm(this.path(key), { force: true }).catch(() => undefined)
      return
    }
    this.remember(id, record)
    await this.write(key, record)
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

  /** For a removed or reset server profile, like LocalCache.removeServerNamespaces. */
  removeNamespaces(namespaces: readonly string[]): void {
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
      if (this.records.size <= RECENT_RECORDS) break
      this.records.delete(oldest)
    }
  }

  /** One directory per server, so removing a profile's entries needs no file reads. */
  private path(key: string[]): string {
    return join(this.root, digest(key[0]), `${digest(key.join('\0'))}.json`)
  }

  private async read<T>(key: string[]): Promise<T | null> {
    const path = this.path(key)
    try {
      const stored = JSON.parse(await readFile(path, 'utf8')) as { key?: unknown; value?: T }
      if (JSON.stringify(stored.key) !== JSON.stringify(key) || stored.value === undefined) return null
      // Eviction goes by modification time: reading an entry makes it the most recently used.
      const now = new Date()
      await utimes(path, now, now).catch(() => undefined)
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
    const files: Array<{ path: string; size: number; used: number }> = []
    for (const directory of await readdir(this.root)) {
      for (const name of await readdir(join(this.root, directory)).catch(() => [])) {
        const path = join(this.root, directory, name)
        const info = await stat(path).catch(() => null)
        if (info?.isFile()) files.push({ path, size: info.size, used: info.mtimeMs })
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    for (const file of files.sort((a, b) => a.used - b.used)) {
      if (total <= this.maxBytes) break
      await rm(file.path, { force: true })
      total -= file.size
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}
