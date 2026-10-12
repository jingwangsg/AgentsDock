export type TerminalCommand =
  | 'copy' | 'paste' | 'select-all' | 'clear'
  | 'zoom-in' | 'zoom-out' | 'zoom-reset'
  | 'previous-prompt' | 'next-prompt'

export type TerminalKeyAction = { send: string } | { command: TerminalCommand }

type KeyInput = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/**
 * Keys a native terminal handles itself or encodes differently from xterm.js. Null leaves the key
 * to xterm.js, and unhandled ⌘ chords then reach the app's menu accelerators.
 */
export function terminalKeyAction(event: KeyInput, mac: boolean): TerminalKeyAction | null {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = event
  if (mac) {
    if (meta && !ctrl && !alt) {
      // Terminal.app and iTerm2 line editing: start of line, end of line, delete to start.
      if (!shift && event.key === 'ArrowLeft') return { send: '\x01' }
      if (!shift && event.key === 'ArrowRight') return { send: '\x05' }
      if (!shift && event.key === 'Backspace') return { send: '\x15' }
      if (!shift && event.key === 'ArrowUp') return { command: 'previous-prompt' }
      if (!shift && event.key === 'ArrowDown') return { command: 'next-prompt' }
      if (event.key === '=' || event.key === '+') return { command: 'zoom-in' }
      if (!shift && event.key === '-') return { command: 'zoom-out' }
      if (!shift && event.key === '0') return { command: 'zoom-reset' }
      const letter = shift ? '' : event.key.toLowerCase()
      if (letter === 'c') return { command: 'copy' }
      if (letter === 'v') return { command: 'paste' }
      if (letter === 'a') return { command: 'select-all' }
      if (letter === 'k') return { command: 'clear' }
      return null
    }
    // Word left/right as Terminal.app sends them; xterm.js 6 sends CSI 1;3 D/C instead.
    if (alt && !meta && !ctrl && !shift && event.key === 'ArrowLeft') return { send: '\x1bb' }
    if (alt && !meta && !ctrl && !shift && event.key === 'ArrowRight') return { send: '\x1bf' }
    return null
  }
  // Ctrl+C/V/A/K belong to the shell here, so the terminal's own commands take Ctrl+Shift, as in GNOME Terminal.
  if (ctrl && shift && !alt && !meta) {
    if (event.code === 'KeyC') return { command: 'copy' }
    if (event.code === 'KeyV') return { command: 'paste' }
    if (event.code === 'KeyA') return { command: 'select-all' }
    if (event.code === 'KeyK') return { command: 'clear' }
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

/** A dropped file's path as one shell word: bare when it has only safe characters, otherwise single-quoted. */
export function shellQuotePath(path: string): string {
  if (/^[\w@%+=:,./-]+$/.test(path)) return path
  return `'${path.replaceAll("'", `'\\''`)}'`
}
