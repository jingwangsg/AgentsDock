export type TerminalCommand =
  | 'copy' | 'paste' | 'select-all' | 'clear' | 'find' | 'close'
  | 'zoom-in' | 'zoom-out' | 'zoom-reset'
  | 'previous-prompt' | 'next-prompt'

type TerminalKeyAction = { send: string } | { command: TerminalCommand }

type KeyInput = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/**
 * Keys a native terminal handles itself or encodes differently from xterm.js. Null leaves the key
 * to xterm.js, and unhandled ⌘ chords then reach the app's menu accelerators (⌘F, ⌘W, ⌘L…).
 */
export function terminalKeyAction(event: KeyInput, mac: boolean): TerminalKeyAction | null {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = event
  if (mac) {
    if (meta && !ctrl && !alt) {
      // ⌘+ is ⌘= with or without Shift, depending on the layout.
      if (event.key === '=' || event.key === '+') return { command: 'zoom-in' }
      if (shift) return null
      // Terminal.app and iTerm2 line editing: start of line, end of line, delete to start.
      if (event.key === 'ArrowLeft') return { send: '\x01' }
      if (event.key === 'ArrowRight') return { send: '\x05' }
      if (event.key === 'Backspace') return { send: '\x15' }
      if (event.key === 'ArrowUp') return { command: 'previous-prompt' }
      if (event.key === 'ArrowDown') return { command: 'next-prompt' }
      if (event.key === '-') return { command: 'zoom-out' }
      if (event.key === '0') return { command: 'zoom-reset' }
      const key = event.key.toLowerCase()
      if (key === 'c') return { command: 'copy' }
      if (key === 'v') return { command: 'paste' }
      if (key === 'a') return { command: 'select-all' }
      if (key === 'k') return { command: 'clear' }
      return null
    }
    // Word left/right as Terminal.app sends them; xterm.js 6 sends CSI 1;3 D/C instead.
    if (alt && !meta && !ctrl && !shift && event.key === 'ArrowLeft') return { send: '\x1bb' }
    if (alt && !meta && !ctrl && !shift && event.key === 'ArrowRight') return { send: '\x1bf' }
    return null
  }
  // Control-letters belong to the shell here, so the terminal's own commands take Control-Shift,
  // as in GNOME Terminal and Windows Terminal.
  if (ctrl && shift && !alt && !meta) {
    if (event.code === 'KeyC') return { command: 'copy' }
    if (event.code === 'KeyV') return { command: 'paste' }
    if (event.code === 'KeyA') return { command: 'select-all' }
    if (event.code === 'KeyK') return { command: 'clear' }
    if (event.code === 'KeyF') return { command: 'find' }
    if (event.code === 'KeyW') return { command: 'close' }
    if (event.key === 'ArrowUp') return { command: 'previous-prompt' }
    if (event.key === 'ArrowDown') return { command: 'next-prompt' }
    if (event.key === '+') return { command: 'zoom-in' }
  }
  if (ctrl && !shift && !alt && !meta) {
    if (event.key === '=') return { command: 'zoom-in' }
    if (event.key === '-') return { command: 'zoom-out' }
    if (event.key === '0') return { command: 'zoom-reset' }
  }
  return null
}

/**
 * A dropped file's path as one word for POSIX shells and fish: bare when it has only safe
 * characters, otherwise single-quoted. Inside fish single quotes `\'` and `\\` are escapes, so a
 * backslash is closed out of the quotes like a quote is. Null for names with control characters,
 * which no quoting makes safe to type into a line editor.
 */
export function shellQuotePath(path: string): string | null {
  if (/[\x00-\x1f\x7f]/.test(path)) return null
  if (/^[\w@+:,./-]+$/.test(path)) return path
  return `'${path.replace(/['\\]/g, char => char === "'" ? `'\\''` : `'\\\\'`)}'`
}
