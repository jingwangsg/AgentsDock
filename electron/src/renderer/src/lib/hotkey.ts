/** Turns a recorded key press into an Electron accelerator, and formats one for display. */

const KEY_BY_CODE: Record<string, string> = {
  Space: 'Space', Enter: 'Return', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Escape: 'Escape',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`'
}

export function acceleratorFromKeyboardEvent(event: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  const code = event.code
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3)
    : /^Digit[0-9]$/.test(code) ? code.slice(5)
    : /^F([1-9]|1[0-9]|2[0-4])$/.test(code) ? code
    : KEY_BY_CODE[code] ?? null
  if (!key) return null
  const modifiers = [
    event.metaKey && 'CommandOrControl',
    event.ctrlKey && 'Control',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift'
  ].filter((value): value is string => Boolean(value))
  // A system-wide shortcut needs a real modifier (or a function key); otherwise plain typing would trigger it.
  if (!modifiers.some(modifier => modifier !== 'Shift') && !/^F\d+$/.test(key)) return null
  return [...modifiers, key].join('+')
}

const MAC_SYMBOLS: Record<string, string> = {
  CommandOrControl: '⌘', Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧',
  Return: '↩', Backspace: '⌫', Delete: '⌦', Space: '␣', Up: '↑', Down: '↓', Left: '←', Right: '→', Escape: '⎋', Tab: '⇥'
}

export function formatAccelerator(accelerator: string, mac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')): string {
  const parts = accelerator.split('+')
  if (mac) return parts.map(part => MAC_SYMBOLS[part] ?? part).join('')
  return parts.map(part => part === 'CommandOrControl' ? 'Ctrl' : part).join('+')
}
