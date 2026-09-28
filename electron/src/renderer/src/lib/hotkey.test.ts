import { describe, expect, it } from 'vitest'
import { acceleratorFromKeyboardEvent, formatAccelerator } from './hotkey'

const press = (code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
  ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('acceleratorFromKeyboardEvent', () => {
  it('builds an Electron accelerator from modifiers + key code', () => {
    expect(acceleratorFromKeyboardEvent(press('KeyA', { metaKey: true, shiftKey: true }))).toBe('CommandOrControl+Shift+A')
    expect(acceleratorFromKeyboardEvent(press('Space', { ctrlKey: true }))).toBe('Control+Space')
    expect(acceleratorFromKeyboardEvent(press('Digit1', { altKey: true }))).toBe('Alt+1')
    expect(acceleratorFromKeyboardEvent(press('Comma', { metaKey: true }))).toBe('CommandOrControl+,')
  })

  it('accepts bare function keys but rejects keys without a real modifier', () => {
    expect(acceleratorFromKeyboardEvent(press('F5'))).toBe('F5')
    expect(acceleratorFromKeyboardEvent(press('KeyA'))).toBeNull()
    expect(acceleratorFromKeyboardEvent(press('KeyA', { shiftKey: true }))).toBeNull()
    expect(acceleratorFromKeyboardEvent(press('ShiftLeft', { shiftKey: true }))).toBeNull()
    expect(acceleratorFromKeyboardEvent(press('MetaLeft', { metaKey: true }))).toBeNull()
  })
})

describe('formatAccelerator', () => {
  it('uses macOS glyphs on Mac and words elsewhere', () => {
    expect(formatAccelerator('CommandOrControl+Shift+A', true)).toBe('⌘⇧A')
    expect(formatAccelerator('Control+Space', true)).toBe('⌃␣')
    expect(formatAccelerator('CommandOrControl+Shift+A', false)).toBe('Ctrl+Shift+A')
  })
})
