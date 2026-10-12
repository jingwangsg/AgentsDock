// The contract between the Android terminal web view (scripts/terminal-page-entry.ts) and its React Native
// host (src/components/terminal/TerminalViewport.android.tsx).
import type { TerminalCommand } from './terminalProtocol'

export type TerminalCursorStyle = 'bar' | 'block' | 'underline'

export const TERMINAL_FONT_SIZE_MIN = 8
export const TERMINAL_FONT_SIZE_MAX = 32

/** The setting, a tab's zoom and a pinch all stay whole pixels within the desktop's bounds. */
export function clampTerminalFontSize(size: number): number {
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(size)))
}

/** What the host may change while the terminal runs; applied without reloading the page. */
export interface TerminalPageOptions {
  background: string
  foreground: string
  cursor: string
  selection: string
  /** Picks the find highlight colours. */
  dark: boolean
  fontSize: number
  cursorStyle: TerminalCursorStyle
  cursorBlink: boolean
  scrollback: number
  screenReader: boolean
  copyOnSelect: boolean
}

export interface TerminalPageConfig {
  socketURL: string
  /** A terminal tab (acknowledges output), not a chat's tmux session. */
  standalone: boolean
  /** The system monospace font, then a bundled fallback for prompt glyphs it lacks. */
  fontFamily: string
  options: TerminalPageOptions
  /** The shell exited and the user has not asked for a new one: the page does not connect until restart(). */
  exited: boolean
}

export type TerminalPageStatus = 'Connecting' | 'Connected' | 'Reconnecting' | 'Error' | 'Exited'

/** Keys the key row sends; Ctrl and Alt are sticky modifiers applied to the next key. */
export type TerminalKeyName =
  | 'escape' | 'tab' | 'backtab' | 'enter' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'dash' | 'slash' | 'pipe' | 'tilde'
  | 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12'

export interface TerminalFindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

/** Messages the page posts to the host. */
export type TerminalPageMessage =
  /** Setup finished: the page takes calls from here on, and the host sends what changed while it loaded. */
  | { type: 'ready' }
  | { type: 'status'; status: TerminalPageStatus; name?: string; message?: string }
  | { type: 'modifiers'; ctrl: boolean; alt: boolean }
  | { type: 'copy'; requestId: number; text: string }
  /** OSC 52 writes, copy on select and Ctrl+Shift+C: text for the system clipboard. */
  | { type: 'clipboard'; text: string }
  /** Hardware-keyboard commands the host carries out: paste reads the clipboard, find opens its bar. */
  | { type: 'command'; command: Extract<TerminalCommand, 'paste' | 'find' | 'close' | 'zoom-in' | 'zoom-out' | 'zoom-reset'> }
  | { type: 'link'; uri: string }
  | { type: 'find-results'; index: number; count: number }
  /** A pinch set this font size. */
  | { type: 'font-size'; fontSize: number }

/** What the host calls on `window.__agentsDockTerminal` through injected JavaScript. */
export interface TerminalPageApi {
  focus(): void
  blur(): void
  paste(text: string): void
  copy(requestId: number): void
  key(name: TerminalKeyName): void
  modifier(name: 'ctrl' | 'alt', active: boolean): void
  configure(options: TerminalPageOptions): void
  find(query: string, options: TerminalFindOptions, direction: 1 | -1, incremental: boolean): void
  clearFind(): void
  jumpPrompt(direction: 'previous' | 'next'): void
  /** Shows the buffer as selectable text with the system's selection handles, or returns to the terminal. */
  selectText(on: boolean): void
  /** Connects again after the shell exited or the connection failed; a new shell starts if the old one ended. */
  restart(): void
}
