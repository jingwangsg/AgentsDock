import { describe, expect, it } from 'vitest'
import { shellQuotePath, terminalKeyAction } from './terminal-input'

const key = (key: string, modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}, code = '') => ({
  key, code, metaKey: Boolean(modifiers.meta), ctrlKey: Boolean(modifiers.ctrl), altKey: Boolean(modifiers.alt), shiftKey: Boolean(modifiers.shift)
})

describe('terminalKeyAction on macOS', () => {
  const mac = (event: ReturnType<typeof key>) => terminalKeyAction(event, true)

  it('sends the line-editing bytes Terminal.app sends for ⌘ and ⌥ arrows and ⌘⌫', () => {
    expect(mac(key('ArrowLeft', { meta: true }))).toEqual({ send: '\x01' })
    expect(mac(key('ArrowRight', { meta: true }))).toEqual({ send: '\x05' })
    expect(mac(key('Backspace', { meta: true }))).toEqual({ send: '\x15' })
    expect(mac(key('ArrowLeft', { alt: true }))).toEqual({ send: '\x1bb' })
    expect(mac(key('ArrowRight', { alt: true }))).toEqual({ send: '\x1bf' })
  })

  it('leaves Control keys, ⌥⌫, Shift-Tab and plain typing to xterm.js', () => {
    for (const event of [key('l', { ctrl: true }), key('i', { ctrl: true }), key('[', { ctrl: true }), key('v', { ctrl: true }),
      key('Backspace', { alt: true }), key('Tab', { shift: true }), key('b', { alt: true }), key('a'), key('ArrowLeft', { shift: true, alt: true })]) {
      expect(mac(event), event.key).toBeNull()
    }
  })

  it('maps the clipboard, clear, zoom and prompt chords to terminal commands', () => {
    expect(mac(key('c', { meta: true }))).toEqual({ command: 'copy' })
    expect(mac(key('v', { meta: true }))).toEqual({ command: 'paste' })
    expect(mac(key('a', { meta: true }))).toEqual({ command: 'select-all' })
    expect(mac(key('k', { meta: true }))).toEqual({ command: 'clear' })
    expect(mac(key('=', { meta: true }))).toEqual({ command: 'zoom-in' })
    expect(mac(key('+', { meta: true, shift: true }))).toEqual({ command: 'zoom-in' })
    expect(mac(key('-', { meta: true }))).toEqual({ command: 'zoom-out' })
    expect(mac(key('0', { meta: true }))).toEqual({ command: 'zoom-reset' })
    expect(mac(key('ArrowUp', { meta: true }))).toEqual({ command: 'previous-prompt' })
    expect(mac(key('ArrowDown', { meta: true }))).toEqual({ command: 'next-prompt' })
  })

  it('leaves the app’s ⌘ chords to the menu accelerators', () => {
    for (const letter of ['w', 'b', 'r', 't', 'n', 'p', 'o', 'f', 'l', ',']) expect(mac(key(letter, { meta: true })), letter).toBeNull()
    expect(mac(key('C', { meta: true, shift: true }))).toBeNull()
    expect(mac(key('ArrowLeft', { meta: true, alt: true }))).toBeNull()
  })
})

describe('terminalKeyAction elsewhere', () => {
  const other = (event: ReturnType<typeof key>) => terminalKeyAction(event, false)

  it('keeps Control-C/V/A/K for the shell and moves the terminal commands to Control-Shift', () => {
    for (const letter of ['c', 'v', 'a', 'k', 'l']) expect(other(key(letter, { ctrl: true }, `Key${letter.toUpperCase()}`))).toBeNull()
    expect(other(key('C', { ctrl: true, shift: true }, 'KeyC'))).toEqual({ command: 'copy' })
    expect(other(key('V', { ctrl: true, shift: true }, 'KeyV'))).toEqual({ command: 'paste' })
    expect(other(key('A', { ctrl: true, shift: true }, 'KeyA'))).toEqual({ command: 'select-all' })
    expect(other(key('K', { ctrl: true, shift: true }, 'KeyK'))).toEqual({ command: 'clear' })
    expect(other(key('=', { ctrl: true }))).toEqual({ command: 'zoom-in' })
    expect(other(key('0', { ctrl: true }))).toEqual({ command: 'zoom-reset' })
  })

  it('does not reinterpret ⌘-style chords', () => {
    expect(other(key('ArrowLeft', { meta: true }))).toBeNull()
    expect(other(key('ArrowLeft', { alt: true }))).toBeNull()
  })
})

describe('shellQuotePath', () => {
  it('passes plain paths through and single-quotes the rest so the shell reads one word', () => {
    expect(shellQuotePath('/Users/me/notes-2026.md')).toBe('/Users/me/notes-2026.md')
    expect(shellQuotePath('/tmp/my file.txt')).toBe(`'/tmp/my file.txt'`)
    expect(shellQuotePath(`/tmp/it's $HOME;rm`)).toBe(`'/tmp/it'\\''s $HOME;rm'`)
    expect(shellQuotePath('/tmp/中文.png')).toBe(`'/tmp/中文.png'`)
  })
})
