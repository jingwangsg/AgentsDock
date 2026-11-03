/**
 * Wire constants shared by the agentsdock-canvas:// protocol handler (main)
 * and the Canvas pane that embeds its pages (renderer). Both sides must agree
 * on the URL layout and the postMessage `source` tags, so they live here once.
 */

export interface CanvasHostTheme {
  background: string
  foreground: string
  muted: string
  border: string
  accent: string
  kind: 'light' | 'dark'
}

export interface CanvasPageResource {
  profileId: string
  profileGeneration: number
  sessionId: string
  name: string
  /** Host theme JSON forwarded to the runtime at mount time. */
  theme: CanvasHostTheme
}

export const CANVAS_SCHEME = 'agentsdock-canvas'
/** `source` of postMessage payloads the parent sends into the page. */
export const CANVAS_HOST_MESSAGE_SOURCE = 'agentsdock-canvas-host'
/** `source` of postMessage payloads the page sends to the parent. */
export const CANVAS_PAGE_MESSAGE_SOURCE = 'agentsdock-canvas'
/** A Canvas name is the stem of `<name>.canvas.tsx`; it is also a URL path segment. */
export const CANVAS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Compared without key order: the server stores a state with sorted keys, a page reports its keys in its own order. */
export function sameCanvasState(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const sorted = (value: unknown): string => JSON.stringify(value ?? {}, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0))
    : item)
  return sorted(a) === sorted(b)
}

/** `reloadKey` only changes the URL so the iframe remounts; parseCanvasURL ignores it. */
export function canvasPageURL(resource: CanvasPageResource & { reloadKey?: string }): string {
  const encoded = [resource.profileId, String(resource.profileGeneration), resource.sessionId, resource.name].map(encodeURIComponent)
  const url = new URL(`${CANVAS_SCHEME}://canvas/${encoded.join('/')}/index.html`)
  url.searchParams.set('theme', JSON.stringify(resource.theme))
  if (resource.reloadKey) url.searchParams.set('r', resource.reloadKey)
  return url.toString()
}
