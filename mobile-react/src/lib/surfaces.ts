import type { Surface, UpdateSurfaceInput } from '../types'

/** The user's rename wins; otherwise a browser tab shows its page title and a terminal tab says "Terminal". */
export function surfaceTitle(surface: Surface): string {
  if (surface.name) return surface.name
  return surface.kind === 'browser' ? surface.page_title || 'Browser' : 'Terminal'
}

/** List and header meta line: the shell's directory, or the page's host. */
export function surfaceSubline(surface: Surface): string {
  if (surface.kind === 'terminal') {
    const parts = (surface.cwd ?? '').split('/').filter(Boolean)
    return parts.slice(-2).join(' / ') || 'Terminal'
  }
  if (!surface.url) return 'Browser'
  return new URL(surface.url).host || surface.url
}

/**
 * Asks for a tab's name and resolves the patch to send, or null when cancelled or unchanged.
 * An emptied name drops the rename, so the default title (page title or "Terminal") returns.
 */
export async function promptSurfaceRename(
  surface: Surface,
  promptText: (options: { title: string; initialValue: string; confirmLabel: string; placeholder: string }) => Promise<string | null>,
): Promise<UpdateSurfaceInput | null> {
  const value = await promptText({
    title: 'Rename Tab',
    initialValue: surfaceTitle(surface),
    confirmLabel: 'Rename',
    placeholder: surface.kind === 'terminal' ? 'Terminal' : 'Browser',
  })
  if (value === null) return null
  const name = value.trim() || null
  return name === surface.name ? null : { name }
}

/** Turns what was typed into the address bar into a page to load: a URL, a bare host, or a web search. */
export function browserAddressURL(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return value
  if (/^(localhost|127\.0\.0\.1|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/\S*)?$/i.test(value)) return `http://${value}`
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(value)) return `https://${value}`
  // Other schemes (file:, javascript:, …) are not web pages.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null
  return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`
}
