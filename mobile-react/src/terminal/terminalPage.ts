// The contract between the Android terminal web view (scripts/terminal-page-entry.ts) and its React Native
// host (src/components/terminal/TerminalViewport.android.tsx).

export interface TerminalPageConfig {
  socketURL: string
  /** A terminal tab (acknowledges output), not a chat's tmux session. */
  standalone: boolean
  /** The system monospace font, then a bundled fallback for prompt glyphs it lacks. */
  fontFamily: string
  backgroundHex: string
  foregroundHex: string
  cursorHex: string
  selectionHex: string
  fontSize: number
  /** The shell exited and the user has not asked for a new one: the page does not connect until restart(). */
  exited: boolean
}

export type TerminalPageStatus = 'Connecting' | 'Connected' | 'Reconnecting' | 'Error' | 'Exited'

/** Keys the key row sends; Ctrl and Alt are sticky modifiers applied to the next key. */
export type TerminalKeyName =
  | 'escape' | 'tab' | 'enter' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'dash' | 'slash' | 'pipe' | 'tilde'

/** Messages the page posts to the host. */
export type TerminalPageMessage =
  | { type: 'status'; status: TerminalPageStatus; name?: string; message?: string }
  | { type: 'modifiers'; ctrl: boolean; alt: boolean }
  | { type: 'copy'; requestId: number; text: string }

/** What the host calls on `window.__agentsDockTerminal` through injected JavaScript. */
export interface TerminalPageApi {
  focus(): void
  blur(): void
  paste(text: string): void
  copy(requestId: number): void
  key(name: TerminalKeyName): void
  modifier(name: 'ctrl' | 'alt', active: boolean): void
  /** Connects again after the shell exited or the connection failed; a new shell starts if the old one ended. */
  restart(): void
}
