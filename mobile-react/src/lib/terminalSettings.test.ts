import assert from 'node:assert/strict'
import test from 'node:test'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { DEFAULT_TERMINAL_SETTINGS, loadTerminalSettings, normalizeTerminalSettings, readTerminalSettings, updateTerminalSettings } from './terminalSettings'

// Same cases as the desktop suite (electron/src/renderer/src/lib/terminal-settings.test.ts).
test('terminal settings start with a bar cursor, no copy on select and 10,000 lines of scrollback', () => {
  assert.deepEqual(readTerminalSettings(), DEFAULT_TERMINAL_SETTINGS)
  assert.deepEqual(DEFAULT_TERMINAL_SETTINGS, { fontSize: 13, cursorStyle: 'bar', cursorBlink: true, copyOnSelect: false, scrollback: 10_000, screenReader: false })
})

test('a change made while the stored settings load wins, and is stored', async () => {
  await AsyncStorage.setItem('agentsdock.terminalSettings', JSON.stringify({ fontSize: 20, cursorBlink: false }))
  const loading = loadTerminalSettings()
  updateTerminalSettings({ fontSize: 15, copyOnSelect: true })
  await loading
  const first = readTerminalSettings()
  assert.deepEqual(first, { ...DEFAULT_TERMINAL_SETTINGS, fontSize: 15, copyOnSelect: true })
  assert.equal(readTerminalSettings(), first, 'the same object until the next change')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(JSON.parse((await AsyncStorage.getItem('agentsdock.terminalSettings'))!), first)
})

test('stored values the app cannot use are replaced', () => {
  assert.deepEqual(
    normalizeTerminalSettings({ fontSize: 400, cursorStyle: 'beam', scrollback: 12, copyOnSelect: 'yes', cursorBlink: false }),
    { ...DEFAULT_TERMINAL_SETTINGS, fontSize: 32, cursorBlink: false },
  )
  assert.deepEqual(normalizeTerminalSettings('{not json'), DEFAULT_TERMINAL_SETTINGS)
})
