import { app, globalShortcut, ipcMain } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const DEFAULT_GLOBAL_HOTKEY = 'CommandOrControl+Shift+A'

export interface GlobalHotkeyState {
  accelerator: string | null
  /** Accelerator that failed to register (taken by another app), or null. */
  error: string | null
}

/**
 * System-wide "bring AgentsDock to front" shortcut. The accelerator is stored in
 * userData/global-hotkey.json; `null` means disabled. Exposed to the renderer as
 * `native:global-hotkey:get` / `native:global-hotkey:set`.
 */
export function installGlobalHotkey(bringToFront: () => void, file = join(app.getPath('userData'), 'global-hotkey.json')): void {
  const read = (): string | null => {
    try {
      const value = (JSON.parse(readFileSync(file, 'utf8')) as { accelerator?: unknown }).accelerator
      return value === null || typeof value === 'string' ? value : DEFAULT_GLOBAL_HOTKEY
    } catch {
      return DEFAULT_GLOBAL_HOTKEY
    }
  }
  // Returns the accelerator that could not be registered, or null on success.
  const apply = (accelerator: string | null): string | null => {
    globalShortcut.unregisterAll()
    if (!accelerator) return null
    try {
      return globalShortcut.register(accelerator, bringToFront) ? null : accelerator
    } catch {
      return accelerator
    }
  }

  const state: GlobalHotkeyState = { accelerator: read(), error: null }
  state.error = apply(state.accelerator)
  if (state.error) state.accelerator = null

  ipcMain.handle('native:global-hotkey:get', (): GlobalHotkeyState => ({ ...state }))
  ipcMain.handle('native:global-hotkey:set', (_event, accelerator: unknown): GlobalHotkeyState => {
    const next = accelerator === null ? null : typeof accelerator === 'string' ? accelerator.trim() || null : undefined
    if (next === undefined) throw new Error('accelerator must be a string or null')
    const error = apply(next)
    if (error) {
      apply(state.accelerator)
      return { accelerator: state.accelerator, error }
    }
    state.accelerator = next
    state.error = null
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ accelerator: next }))
    return { ...state }
  })
  app.on('will-quit', () => globalShortcut.unregisterAll())
}
