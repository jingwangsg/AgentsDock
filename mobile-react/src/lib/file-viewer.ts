const GENERIC_BINARY_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream'])
const TEXT_EXTENSIONS = new Set([
  'bash', 'c', 'cc', 'cfg', 'conf', 'cpp', 'cs', 'css', 'csv', 'diff', 'env',
  'fish', 'go', 'graphql', 'h', 'hcl', 'hpp', 'htm', 'html', 'ini', 'java',
  'js', 'json', 'jsonc', 'jsx', 'kt', 'log', 'lua', 'm', 'mdx', 'mjs', 'mm',
  'mts', 'plist', 'properties', 'proto', 'py', 'rb', 'rs', 'scss', 'sh', 'sql',
  'svg', 'swift', 'tf', 'toml', 'ts', 'tsx', 'txt', 'xml', 'yaml', 'yml', 'zsh',
])
const TEXT_FILENAMES = new Set([
  'dockerfile', 'gemfile', 'license', 'makefile', 'procfile', 'readme', 'workspace',
])

export type MobileFileViewerKind = 'image' | 'video' | 'pdf' | 'markdown' | 'text' | 'unsupported'
export type MobileFileViewerLayout = 'phone' | 'pad'

export interface MobileFileViewerPaneVisibility {
  browser: boolean
  preview: boolean
}

export const PHONE_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024
export const PAD_TEXT_PREVIEW_BYTES = 8 * 1024 * 1024

export interface FileViewerEntryLike {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink'
  hidden?: boolean
}

export function mobileFileViewerLayout(width: number, height: number): MobileFileViewerLayout {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 'phone'
  return width >= 720 && Math.min(width, height) >= 600 ? 'pad' : 'phone'
}

export function mobileTextPreviewLimit(layout: MobileFileViewerLayout): number {
  return layout === 'pad' ? PAD_TEXT_PREVIEW_BYTES : PHONE_TEXT_PREVIEW_BYTES
}

export function mobileFileViewerPaneVisibility(layout: MobileFileViewerLayout, hasSelection: boolean): MobileFileViewerPaneVisibility {
  if (layout === 'pad') return { browser: true, preview: true }
  return hasSelection
    ? { browser: false, preview: true }
    : { browser: true, preview: false }
}

export function mobileFileViewerKind(filename: string, recordedContentType?: string | null): MobileFileViewerKind {
  const contentType = effectiveContentType(filename, recordedContentType)
  const baseType = contentType.split(';', 1)[0].trim()
  if (baseType.startsWith('image/') && baseType !== 'image/svg+xml') return 'image'
  if (baseType.startsWith('video/')) return 'video'
  if (baseType === 'application/pdf') return 'pdf'
  if (baseType === 'text/markdown' || /\.(?:md|markdown)$/i.test(filename)) return 'markdown'
  if (isTextFile(filename, baseType)) return 'text'
  return 'unsupported'
}

export function inferredMobileFileContentType(filename: string): string {
  const lower = filename.toLocaleLowerCase().split(/[?#]/, 1)[0]
  if (/\.ico$/.test(lower)) return 'image/x-icon'
  if (/\.tiff?$/.test(lower)) return 'image/tiff'
  if (/\.(?:png|jpe?g|gif|webp|avif|bmp|ico|tiff?)$/.test(lower)) return `image/${lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'jpeg' : lower.split('.').at(-1)}`
  if (/\.(?:mp4|m4v)$/.test(lower)) return 'video/mp4'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (/\.(?:md|markdown)$/.test(lower)) return 'text/markdown'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.csv')) return 'text/csv'
  if (isTextFile(lower, '')) return 'text/plain'
  return 'application/octet-stream'
}

export function parentWorkspacePath(path: string): string {
  const clean = normalizedWorkspacePath(path)
  const separator = clean.lastIndexOf('/')
  return separator < 0 ? '' : clean.slice(0, separator)
}

export function workspaceRelativeSourcePath(sourcePath?: string | null, workspaceRoot?: string | null): string | null {
  const source = normalizedAbsolutePath(sourcePath)
  const root = normalizedAbsolutePath(workspaceRoot)
  if (!source || !root) return null
  const caseInsensitive = /^[a-z]:\//i.test(root)
  const comparableSource = caseInsensitive ? source.toLocaleLowerCase() : source
  const comparableRoot = caseInsensitive ? root.toLocaleLowerCase() : root
  const prefix = comparableRoot.endsWith('/') ? comparableRoot : `${comparableRoot}/`
  if (!comparableSource.startsWith(prefix)) return null
  const relative = source.slice(prefix.length).replace(/^\/+/, '')
  return relative && !relative.split('/').includes('..') ? relative : null
}

export type WorkspacePathLinkTarget =
  | { kind: 'workspace'; path: string }
  | { kind: 'absolute'; path: string }
  | { kind: 'outside'; path: string }

/**
 * Resolves a chat's path link against the chat cwd. Paths inside cwd open
 * through the workspace routes (`path` '' is cwd itself). Any other file the
 * link names on the server is `absolute`, in the canonical form the server's
 * absolute-file routes require; those routes also expand a leading `~/` as
 * the server account's home. `outside` is left for links that name no file:
 * a climb above the root, or a climb out of a chat without a working directory.
 */
export function workspacePathLinkTarget(href: string, cwd?: string | null): WorkspacePathLinkTarget {
  let path = href.trim()
  try { path = decodeURIComponent(path) } catch { /* markdown-it encodes hrefs; keep text it could not decode */ }
  const absolute = normalizedAbsolutePath(path)
  if (absolute !== null) return absolutePathLinkTarget(absolute, cwd)
  if (path.startsWith('~')) {
    const home = path.startsWith('~/') ? normalizedAbsolutePath(path.slice(1)) : null
    return home && home !== '/' ? { kind: 'absolute', path: `~${home}` } : { kind: 'outside', path }
  }
  // Rooting the relative path reuses the dot-segment rules; null means it climbs out of cwd.
  const relative = normalizedAbsolutePath(`/${path}`)
  if (relative !== null) return { kind: 'workspace', path: relative.slice(1) }
  // A climb out of cwd (../sibling/REVIEW.md) still names one file: resolve it against cwd.
  const normalizedCwd = normalizedAbsolutePath(cwd)
  const resolved = normalizedCwd ? normalizedAbsolutePath(`${normalizedCwd}/${path}`) : null
  return resolved ? absolutePathLinkTarget(resolved, cwd) : { kind: 'outside', path }
}

function absolutePathLinkTarget(absolute: string, cwd?: string | null): WorkspacePathLinkTarget {
  if (absolute === normalizedAbsolutePath(cwd)) return { kind: 'workspace', path: '' }
  const relative = workspaceRelativeSourcePath(absolute, cwd)
  return relative ? { kind: 'workspace', path: relative } : { kind: 'absolute', path: absolute }
}

/** Whether the server's preview route serves this file: an advertised image or PDF type within the preview size limit. */
export function workspacePreviewAllowed(info: { max_preview_file_bytes?: number; preview_media_types?: string[] } | null, entry: { name: string; size?: number | null }): boolean {
  if (typeof entry.size === 'number' && typeof info?.max_preview_file_bytes === 'number' && entry.size > info.max_preview_file_bytes) return false
  const contentType = inferredMobileFileContentType(entry.name).toLowerCase()
  const advertised = info?.preview_media_types
  if (!advertised?.length) return contentType.startsWith('image/') || contentType === 'application/pdf'
  return advertised.some(value => {
    const pattern = value.toLowerCase().trim()
    return pattern.endsWith('/*') ? contentType.startsWith(pattern.slice(0, -1)) : pattern === contentType
  })
}

/** Short stable name for a cached preview copy of a server file. */
export function fileViewerCacheKey(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

export function joinWorkspacePath(directory: string, name: string): string {
  const base = normalizedWorkspacePath(directory)
  const leaf = name.replace(/^\/+|\/+$/g, '')
  return base ? `${base}/${leaf}` : leaf
}

export function workspacePathSegments(path: string): Array<{ label: string; path: string }> {
  const parts = normalizedWorkspacePath(path).split('/').filter(Boolean)
  const segments: Array<{ label: string; path: string }> = [{ label: 'Workspace', path: '' }]
  let current = ''
  for (const part of parts) {
    current = current ? `${current}/${part}` : part
    segments.push({ label: part, path: current })
  }
  return segments
}

export function sortFileViewerEntries<T extends FileViewerEntryLike>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => {
    const leftRank = left.kind === 'directory' ? 0 : left.kind === 'file' ? 1 : 2
    const rightRank = right.kind === 'directory' ? 0 : right.kind === 'file' ? 1 : 2
    if (leftRank !== rightRank) return leftRank - rightRank
    if (Boolean(left.hidden) !== Boolean(right.hidden)) return left.hidden ? 1 : -1
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function effectiveContentType(filename: string, recordedContentType?: string | null): string {
  const recorded = String(recordedContentType ?? '').trim().toLocaleLowerCase()
  const baseType = recorded.split(';', 1)[0].trim()
  return GENERIC_BINARY_TYPES.has(baseType) ? inferredMobileFileContentType(filename) : recorded
}

function isTextFile(filename: string, contentType: string): boolean {
  if (contentType.startsWith('text/')) return true
  if (/^application\/(?:json|ld\+json|toml|x-httpd-php|x-javascript|x-sh|xml|yaml)$/.test(contentType)) return true
  if (/\+(?:json|xml)$/.test(contentType)) return true
  const name = filename.toLocaleLowerCase().split(/[?#]/, 1)[0].split('/').at(-1) ?? ''
  if (TEXT_FILENAMES.has(name) || name.startsWith('dockerfile.') || name.startsWith('license') || name.startsWith('readme')) return true
  const extension = name.includes('.') ? name.split('.').at(-1) ?? '' : ''
  return TEXT_EXTENSIONS.has(extension)
}

function normalizedWorkspacePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/')
}

function normalizedAbsolutePath(value?: string | null): string | null {
  const raw = value?.trim().replace(/\\/g, '/')
  if (!raw || (!raw.startsWith('/') && !/^[a-z]:\//i.test(raw))) return null
  const drive = /^[a-z]:\//i.exec(raw)?.[0].slice(0, 2) ?? ''
  const parts: string[] = []
  for (const part of raw.slice(drive ? 3 : 1).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  return drive ? `${drive}/${parts.join('/')}` : `/${parts.join('/')}`
}
