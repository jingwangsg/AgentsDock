import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSyncExternalStore } from 'react'
import { clampTerminalFontSize, type TerminalCursorStyle } from '../terminal/terminalPage'

// Port of electron/src/renderer/src/lib/terminal-settings.ts. The desktop's font family and Option as Meta
// have no Android counterpart: the web view has the system monospace font, and Android keyboards have no Option.
export interface TerminalSettings {
  /** Before the app text size, which scales it like the rest of the app. */
  fontSize: number
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  copyOnSelect: boolean
  scrollback: number
  screenReader: boolean
}

export const TERMINAL_SCROLLBACK_OPTIONS = [1_000, 5_000, 10_000, 25_000, 50_000] as const
export const DEFAULT_TERMINAL_SETTINGS: Readonly<TerminalSettings> = {
  fontSize: 13,
  cursorStyle: 'bar',
  cursorBlink: true,
  copyOnSelect: false,
  scrollback: 10_000,
  screenReader: false,
}

const STORAGE_KEY = 'agentsdock.terminalSettings'
const listeners = new Set<() => void>()
let current: TerminalSettings = DEFAULT_TERMINAL_SETTINGS
let loading: Promise<void> | null = null
let changedBeforeLoad = false

export function normalizeTerminalSettings(value: unknown): TerminalSettings {
  const input = value && typeof value === 'object' ? value as Partial<Record<keyof TerminalSettings, unknown>> : {}
  const defaults = DEFAULT_TERMINAL_SETTINGS
  const flag = (key: 'cursorBlink' | 'copyOnSelect' | 'screenReader') => typeof input[key] === 'boolean' ? input[key] as boolean : defaults[key]
  return {
    fontSize: typeof input.fontSize === 'number' && Number.isFinite(input.fontSize) ? clampTerminalFontSize(input.fontSize) : defaults.fontSize,
    cursorStyle: input.cursorStyle === 'block' || input.cursorStyle === 'underline' || input.cursorStyle === 'bar' ? input.cursorStyle : defaults.cursorStyle,
    cursorBlink: flag('cursorBlink'),
    copyOnSelect: flag('copyOnSelect'),
    scrollback: TERMINAL_SCROLLBACK_OPTIONS.includes(input.scrollback as never) ? input.scrollback as number : defaults.scrollback,
    screenReader: flag('screenReader'),
  }
}

function changed(): void {
  for (const listener of listeners) listener()
}

/** Reads the stored settings once; until then, and when nothing is stored, the defaults apply. */
export function loadTerminalSettings(): Promise<void> {
  loading ??= AsyncStorage.getItem(STORAGE_KEY).then(raw => {
    // load-bearing: a change made while the read was in flight is newer than what was stored.
    if (changedBeforeLoad || !raw) return
    current = normalizeTerminalSettings(JSON.parse(raw))
    changed()
  }).catch(() => undefined)
  return loading
}

export function readTerminalSettings(): TerminalSettings {
  return current
}

export function updateTerminalSettings(patch: Partial<TerminalSettings>): void {
  changedBeforeLoad = true
  current = normalizeTerminalSettings({ ...current, ...patch })
  changed()
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(current)).catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  void loadTerminalSettings()
  return () => { listeners.delete(listener) }
}

export function useTerminalSettings(): TerminalSettings {
  return useSyncExternalStore(subscribe, readTerminalSettings, readTerminalSettings)
}
