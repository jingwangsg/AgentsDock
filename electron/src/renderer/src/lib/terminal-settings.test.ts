import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TERMINAL_SETTINGS, readTerminalSettings, updateTerminalSettings } from './terminal-settings'

describe('terminal settings', () => {
  beforeEach(() => localStorage.clear())

  it('starts with Option composing characters, no copy on select and 10,000 lines of scrollback', () => {
    expect(readTerminalSettings()).toEqual(DEFAULT_TERMINAL_SETTINGS)
    expect(DEFAULT_TERMINAL_SETTINGS).toMatchObject({ optionAsMeta: false, copyOnSelect: false, scrollback: 10_000, screenReader: false })
  })

  it('persists changes and returns the same object until the stored value changes', () => {
    updateTerminalSettings({ fontSize: 15, copyOnSelect: true })
    const first = readTerminalSettings()
    expect(first).toMatchObject({ fontSize: 15, copyOnSelect: true, cursorStyle: 'bar' })
    expect(readTerminalSettings()).toBe(first)
    expect(JSON.parse(localStorage.getItem('agentsdock.terminalSettings')!)).toMatchObject({ fontSize: 15, copyOnSelect: true })
  })

  it('replaces stored values it cannot use', () => {
    localStorage.setItem('agentsdock.terminalSettings', JSON.stringify({ fontSize: 400, cursorStyle: 'beam', scrollback: 12, optionAsMeta: 'yes', fontFamily: '  Iosevka  ' }))
    expect(readTerminalSettings()).toEqual({ ...DEFAULT_TERMINAL_SETTINGS, fontSize: 32, fontFamily: 'Iosevka' })
    localStorage.setItem('agentsdock.terminalSettings', '{not json')
    expect(readTerminalSettings()).toEqual(DEFAULT_TERMINAL_SETTINGS)
  })
})
