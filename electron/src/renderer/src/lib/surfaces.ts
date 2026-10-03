import { t } from '@shared/i18n'
import type { Surface } from '@shared/types'
import { workingDirectoryTail } from './format'

/** The user's rename wins; otherwise a browser tab shows its page title and a terminal tab says "Terminal". */
export function surfaceTitle(surface: Surface): string {
  if (surface.name) return surface.name
  return surface.kind === 'browser' ? surface.page_title || t('surface.browser') : t('surface.terminal')
}

/** Sidebar and header meta line: the shell's directory, or the page's host. */
export function surfaceSubline(surface: Surface): string {
  if (surface.kind === 'terminal') return workingDirectoryTail(surface.cwd) || t('surface.terminal')
  if (!surface.url) return t('surface.browser')
  try {
    return new URL(surface.url).host || surface.url
  } catch {
    return surface.url
  }
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
