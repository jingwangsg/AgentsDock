import { useSyncExternalStore } from 'react'
import { saveLocalStorage } from './local-storage'

export type TerminalCursorStyle = 'bar' | 'block' | 'underline'

export interface TerminalSettings {
  /** A CSS font-family list; empty uses the default stack. */
  fontFamily: string
  fontSize: number
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  /** macOS: ⌥ sends ESC+key instead of composing a character. */
  optionAsMeta: boolean
  copyOnSelect: boolean
  scrollback: number
  screenReader: boolean
}

// Chromium falls back per glyph across this list, so trailing Lilex (bundled; @font-face in
// zed-skin.css) covers powerline and box-drawing glyphs that SF Mono and Menlo miss.
export const DEFAULT_TERMINAL_FONT_FAMILY = '"SFMono-Regular", Menlo, Monaco, "Cascadia Mono", "Lilex", monospace'
export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 32
export const TERMINAL_SCROLLBACK_OPTIONS = [1_000, 5_000, 10_000, 25_000, 50_000] as const
export const DEFAULT_TERMINAL_SETTINGS: Readonly<TerminalSettings> = {
  fontFamily: '',
  fontSize: 13,
  cursorStyle: 'bar',
  cursorBlink: true,
  optionAsMeta: false,
  copyOnSelect: false,
  scrollback: 10_000,
  screenReader: false
}

const STORAGE_KEY = 'agentsdock.terminalSettings'
const listeners = new Set<() => void>()
let cached: { raw: string | null; settings: TerminalSettings } | null = null

export function clampTerminalFontSize(value: number): number {
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(value)))
}

function normalizeTerminalSettings(value: unknown): TerminalSettings {
  const input = value && typeof value === 'object' ? value as Partial<Record<keyof TerminalSettings, unknown>> : {}
  const defaults = DEFAULT_TERMINAL_SETTINGS
  const flag = (key: 'cursorBlink' | 'optionAsMeta' | 'copyOnSelect' | 'screenReader') => typeof input[key] === 'boolean' ? input[key] as boolean : defaults[key]
  return {
    fontFamily: typeof input.fontFamily === 'string' ? input.fontFamily.trim() : defaults.fontFamily,
    fontSize: typeof input.fontSize === 'number' && Number.isFinite(input.fontSize) ? clampTerminalFontSize(input.fontSize) : defaults.fontSize,
    cursorStyle: input.cursorStyle === 'block' || input.cursorStyle === 'underline' || input.cursorStyle === 'bar' ? input.cursorStyle : defaults.cursorStyle,
    cursorBlink: flag('cursorBlink'),
    optionAsMeta: flag('optionAsMeta'),
    copyOnSelect: flag('copyOnSelect'),
    scrollback: TERMINAL_SCROLLBACK_OPTIONS.includes(input.scrollback as never) ? input.scrollback as number : defaults.scrollback,
    screenReader: flag('screenReader')
  }
}

export function readTerminalSettings(): TerminalSettings {
  let raw: string | null = null
  try { raw = window.localStorage.getItem(STORAGE_KEY) } catch { /* defaults */ }
  // useSyncExternalStore needs the same object back until the stored value changes.
  if (cached?.raw === raw) return cached.settings
  let parsed: unknown = null
  try { parsed = raw ? JSON.parse(raw) : null } catch { /* defaults */ }
  cached = { raw, settings: normalizeTerminalSettings(parsed) }
  return cached.settings
}

export function updateTerminalSettings(patch: Partial<TerminalSettings>): void {
  saveLocalStorage(STORAGE_KEY, JSON.stringify(normalizeTerminalSettings({ ...readTerminalSettings(), ...patch })))
  for (const listener of listeners) listener()
}

function storageChanged(event: StorageEvent): void {
  if (event.key === STORAGE_KEY || event.key === null) for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', storageChanged)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('storage', storageChanged)
  }
}

export function useTerminalSettings(): TerminalSettings {
  return useSyncExternalStore(subscribe, readTerminalSettings, () => DEFAULT_TERMINAL_SETTINGS)
}
