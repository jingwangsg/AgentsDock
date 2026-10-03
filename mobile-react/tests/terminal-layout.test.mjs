import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(path.resolve('src/components/TerminalView.tsx'), 'utf8')
const shell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')
const androidTerminal = fs.readFileSync(path.resolve('src/components/terminal/TerminalViewport.android.tsx'), 'utf8')
const promptFont = fs.readFileSync(path.resolve('src/terminal/promptGlyphFont.ts'), 'utf8')

test('terminal toolbar stays outside the platform terminal hit-testing surface', () => {
  const toolbar = source.indexOf('testID="terminal-toolbar"')
  const terminal = source.indexOf('\n      <TerminalViewport')

  assert.ok(toolbar >= 0, 'terminal toolbar must remain identifiable')
  assert.ok(terminal > toolbar, 'toolbar must be laid out before the native terminal')
  assert.doesNotMatch(source, /tabs:\s*\{[^}]*position:\s*['"]absolute['"]/)
  assert.doesNotMatch(source, /terminal:\s*\{[^}]*marginTop:/)
})

test('platform terminal is clipped below an elevated non-collapsible toolbar', () => {
  assert.match(source, /testID="terminal-platform-viewport"/)
  assert.match(source, /terminalViewport:\s*\{[^}]*overflow:\s*['"]hidden['"]/)
  assert.match(source, /tabs:\s*\{[^}]*zIndex:\s*2/)
  assert.match(source, /testID="terminal-toolbar"[\s\S]*?<\/View>[\s\S]*?testID="terminal-platform-viewport"/)
})

test('android terminal keeps the bundled prompt-glyph fallback in its font stack and CSP', () => {
  // Android system monospace fonts lack powerline/PUA glyphs; xterm's per-glyph
  // fallback only reaches the bundled subset if it stays in the fontFamily, the
  // @font-face is injected, and the CSP admits the data: font. Dropping any one
  // silently reintroduces missing-glyph boxes at remote shell prompts.
  assert.match(androidTerminal, /fontFamily: 'monospace, "\$\{PROMPT_GLYPH_FONT_FAMILY\}"'/)
  assert.match(androidTerminal, /@font-face\{font-family:"\$\{PROMPT_GLYPH_FONT_FAMILY\}";src:url\("data:font\/ttf;base64,\$\{PROMPT_GLYPH_FONT_TTF_BASE64\}"\)/)
  assert.match(androidTerminal, /img-src data:; font-src data:;/)
  assert.match(promptFont, /export const PROMPT_GLYPH_FONT_FAMILY = 'AgentsDockPromptGlyphs'/)
  assert.match(promptFont, /export const PROMPT_GLYPH_FONT_TTF_BASE64 =\s*'[A-Za-z0-9+/=]{2000,}'/)
})

test('terminal uses a full-screen modal without a sheet dismissal recognizer', () => {
  const terminalModal = shell.match(/\{modalScopeCurrent && terminal && selected && !isWelcomeSession\(selected\.id\) \? <Modal visible[\s\S]*?<\/Modal> : null\}/)?.[0] ?? ''
  assert.match(terminalModal, /presentationStyle="fullScreen"/)
  assert.doesNotMatch(terminalModal, /allowSwipeDismissal/)
  assert.match(terminalModal, /paddingTop:\s*fullscreenModalTopPadding\(insets, Platform\.OS\)/)
  assert.match(terminalModal, /edges=\{\['right', 'bottom', 'left'\]\}/)
})

test('android terminal sends typed input as binary frames and has a key row', () => {
  // The server reads input only from binary frames; a text frame is a JSON control
  // message and everything else is dropped, which silently ate every keystroke.
  assert.match(androidTerminal, /socket\.send\(encoder\.encode\(text\)\)/)
  assert.doesNotMatch(androidTerminal, /socket\.send\(data\)/)
  assert.match(androidTerminal, /term\.onData\(data => sendInput\(withModifiers\(data\)\)\)/)
  assert.match(source, /testID="terminal-key-row"/)
  for (const label of ['Esc', 'Tab', 'Ctrl', 'Alt', 'Home', 'End']) assert.match(source, new RegExp(`label: '${label}'`))
  assert.match(source, /testID="terminal-platform-viewport"[\s\S]*testID="terminal-key-row"/)
})
