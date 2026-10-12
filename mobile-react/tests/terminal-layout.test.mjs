import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const source = fs.readFileSync(path.resolve('src/components/TerminalView.tsx'), 'utf8')
const shell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')
const androidTerminal = fs.readFileSync(path.resolve('src/components/terminal/TerminalViewport.android.tsx'), 'utf8')
const terminalPage = fs.readFileSync(path.resolve('scripts/terminal-page-entry.ts'), 'utf8')
const terminalProtocol = fs.readFileSync(path.resolve('src/terminal/terminalProtocol.ts'), 'utf8')
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
  assert.match(androidTerminal, /fontFamily: `monospace, "\$\{PROMPT_GLYPH_FONT_FAMILY\}"`/)
  assert.match(terminalPage, /fontFamily: config\.fontFamily/)
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
  assert.match(terminalProtocol, /send\(encoder\.encode\(data\)\)/)
  assert.match(terminalProtocol, /if \(open\) socket!\.send\(frame\)/)
  assert.match(terminalPage, /term\.onData\(data => link\.write\(withModifiers\(data\)\)\)/)
  assert.match(source, /testID="terminal-key-row"/)
  for (const label of ['Esc', 'Tab', 'Enter', 'Ctrl', 'Alt', 'Home', 'End']) assert.match(source, new RegExp(`label: '${label}'`))
  assert.match(terminalPage, /enter: '\\r'/)
  assert.match(source, /testID="terminal-platform-viewport"[\s\S]*testID="terminal-key-row"/)
})

test('the committed android terminal page bundle matches its sources', () => {
  execFileSync(process.execPath, ['scripts/embed-xterm.mjs', '--check'], { stdio: 'pipe' })
})

test('android terminal page is bundled into the HTML rather than written inline in the template', () => {
  // An inline script in the template literal needed every control escape doubled: a single-backslash
  // \x00 became a raw NUL in the generated HTML and truncated it (build 33/34).
  assert.match(androidTerminal, /const script = escapeClosingTag\(TERMINAL_PAGE_JS, 'script'\)/)
  assert.match(androidTerminal, /<script>\$\{script\}<\/script>/)
  assert.doesNotMatch(androidTerminal, /\\x[0-9a-fA-F]{2}/)
})

test('the key row stays above the soft keyboard inside the full-screen terminal modal', () => {
  assert.match(source, /Keyboard\.addListener\('keyboardDidShow'/)
  assert.match(source, /measureInWindow\(\(_x, y, _width, height\) => \{\s*setKeyboardOverlap\(Math\.max\(0, Math\.round\(y \+ height - event\.endCoordinates\.screenY\)\)\)/)
  assert.match(source, /paddingBottom: keyboardOverlap/)
})
