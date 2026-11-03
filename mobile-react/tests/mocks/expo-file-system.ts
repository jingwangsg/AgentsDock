// Files under Paths.cache live in memory (mockCacheFiles), so a test can read back what the app wrote.
const CACHE_ROOT = 'file:///mock-cache'
export const mockCacheFiles = new Map<string, { text: string; modified: number }>()

function joined(parts: Array<string | { uri: string }>): string {
  return parts.map(part => typeof part === 'string' ? part : part.uri).join('/')
}

export class Directory {
  readonly uri: string
  constructor(...parts: Array<string | { uri: string }>) { this.uri = joined(parts) }
  create(): void {}
  list(): File[] {
    return [...mockCacheFiles.keys()].filter(uri => uri.startsWith(`${this.uri}/`)).map(uri => new File(uri))
  }
}

export const Paths = { cache: new Directory(CACHE_ROOT) }

export class File {
  readonly uri: string
  constructor(...parts: Array<string | { uri: string }>) { this.uri = joined(parts) }

  // Opt-in failure hook: a URI carrying the "#unreadable" fragment models an
  // iOS photo whose bytes cannot be materialized (iCloud not downloaded,
  // limited-library, or a File provider). It never affects other fixtures.
  get exists(): boolean {
    return this.uri.startsWith(CACHE_ROOT) ? mockCacheFiles.has(this.uri) : !this.uri.includes('#unreadable')
  }

  get size(): number { return mockCacheFiles.get(this.uri)?.text.length ?? 0 }
  get modificationTime(): number | null { return mockCacheFiles.get(this.uri)?.modified ?? null }
  async text(): Promise<string> {
    const file = mockCacheFiles.get(this.uri)
    if (!file) throw new Error(`no such file: ${this.uri}`)
    return file.text
  }
  write(text: string): void { mockCacheFiles.set(this.uri, { text, modified: Date.now() }) }
  delete(): void { mockCacheFiles.delete(this.uri) }
}
