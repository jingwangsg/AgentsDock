import { COLOR_THEMES } from './color-themes.data'

export type AppearanceMode = 'system' | 'light' | 'dark'
export type ResolvedAppearance = 'light' | 'dark'
/** The color theme used in each appearance, as in Zed's `theme.light` / `theme.dark` settings. */
export type ColorThemeChoice = Record<ResolvedAppearance, string>

const STORAGE_KEY = 'agentsdock.appearance'
const COLOR_THEMES_KEY = 'agentsdock.colorThemes'
const APPEARANCE_EVENT = 'agentsdock:appearance'
// One Light / One Dark are zed-skin.css's own tokens; every other theme overrides its base tokens inline.
const DEFAULT_COLOR_THEMES: ColorThemeChoice = { light: 'one-light', dark: 'one-dark' }
let mediaQuery: MediaQueryList | null = null
let initialized = false

export function resolveAppearance(mode: AppearanceMode, prefersDark: boolean): ResolvedAppearance {
  if (mode === 'system') return prefersDark ? 'dark' : 'light'
  return mode
}

export function readAppearance(): AppearanceMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

/** Theme choices a user can pick for one appearance: One first, then the collected themes. */
export function colorThemeOptions(mode: ResolvedAppearance): { id: string; label: string }[] {
  return [{ id: DEFAULT_COLOR_THEMES[mode], label: mode === 'light' ? 'One Light' : 'One Dark' },
    ...COLOR_THEMES.filter(theme => theme.mode === mode)]
}

export function readColorThemes(): ColorThemeChoice {
  let stored: Partial<ColorThemeChoice> = {}
  try { stored = JSON.parse(window.localStorage.getItem(COLOR_THEMES_KEY) ?? '{}') } catch { /* defaults */ }
  // A stored id can outlive its theme; it then falls back to One.
  const pick = (mode: ResolvedAppearance) => colorThemeOptions(mode).some(option => option.id === stored[mode]) ? stored[mode]! : DEFAULT_COLOR_THEMES[mode]
  return { light: pick('light'), dark: pick('dark') }
}

export function applyAppearance(mode: AppearanceMode): void {
  const prefersDark = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true
  const resolved = resolveAppearance(mode, prefersDark)
  const root = document.documentElement
  const colorTheme = readColorThemes()[resolved]
  const palette = COLOR_THEMES.find(theme => theme.id === colorTheme)?.ui
  for (const token of Object.keys(COLOR_THEMES[0].ui)) root.style.removeProperty(`--${token}`)
  for (const [token, value] of Object.entries(palette ?? {})) root.style.setProperty(`--${token}`, value)
  root.dataset.appearance = mode
  root.dataset.theme = resolved
  root.dataset.colorTheme = colorTheme
  root.style.colorScheme = resolved
}

export function setAppearanceMode(mode: AppearanceMode): void {
  try { window.localStorage.setItem(STORAGE_KEY, mode) } catch { /* keep the active in-memory theme */ }
  applyAppearance(mode)
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: mode }))
}

export function setColorTheme(appearance: ResolvedAppearance, id: string): void {
  window.localStorage.setItem(COLOR_THEMES_KEY, JSON.stringify({ ...readColorThemes(), [appearance]: id }))
  const mode = readAppearance()
  applyAppearance(mode)
  window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: mode }))
}

export function initializeAppearance(): void {
  applyAppearance(readAppearance())
  if (initialized || typeof window.matchMedia !== 'function') return
  initialized = true
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  mediaQuery.addEventListener('change', () => {
    if (readAppearance() === 'system') applyAppearance('system')
  })
}
