import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const source = fs.readFileSync(path.resolve('src/components/TerminalView.tsx'), 'utf8')
const shell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')
const nativeTerminal = fs.readFileSync(path.resolve('src/components/terminal/TerminalViewport.native.tsx'), 'utf8')
const terminalPage = fs.readFileSync(path.resolve('scripts/terminal-page-entry.ts'), 'utf8')
const terminalProtocol = fs.readFileSync(path.resolve('src/terminal/terminalProtocol.ts'), 'utf8')
const promptFont = fs.readFileSync(path.resolve('src/terminal/promptGlyphFont.ts'), 'utf8')
const androidFont = fs.readFileSync(path.resolve('src/terminal/terminalFont.ts'), 'utf8')
const iosFont = fs.readFileSync(path.resolve('src/terminal/terminalFont.ios.ts'), 'utf8')

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

test('mobile terminal keeps the bundled prompt-glyph fallback in its font stack and CSP', () => {
  // The monospace font lacks powerline/PUA glyphs; xterm's per-glyph
  // fallback only reaches the bundled subset if it stays in the fontFamily, the
  // @font-face is injected, and the CSP admits the data: font. Dropping any one
  // silently reintroduces missing-glyph boxes at remote shell prompts.
  assert.match(nativeTerminal, /fontFamily: `\$\{TERMINAL_FONT_FAMILY\}, "\$\{PROMPT_GLYPH_FONT_FAMILY\}"`/)
  assert.match(terminalPage, /fontFamily: config\.fontFamily/)
  assert.match(nativeTerminal, /@font-face\{font-family:"\$\{PROMPT_GLYPH_FONT_FAMILY\}";src:url\("data:font\/ttf;base64,\$\{PROMPT_GLYPH_FONT_TTF_BASE64\}"\)/)
  assert.match(nativeTerminal, /img-src data: blob:; font-src data:;/)
  assert.match(promptFont, /export const PROMPT_GLYPH_FONT_FAMILY = 'AgentsDockPromptGlyphs'/)
  assert.match(promptFont, /export const PROMPT_GLYPH_FONT_TTF_BASE64 =\s*'[A-Za-z0-9+/=]{2000,}'/)
})

test('android draws the system monospace font and iOS bundles the same font, loaded before xterm.js measures it', () => {
  // WebKit's monospace is Courier, whose glyphs and line height differ from Android's Droid Sans Mono.
  assert.match(androidFont, /export const TERMINAL_FONT_FAMILY = 'monospace'/)
  assert.match(androidFont, /export const TERMINAL_FONT_FACE = ''/)
  assert.match(iosFont, /export const TERMINAL_FONT_FAMILY = '"AgentsDock Mono"'/)
  assert.match(iosFont, /export const TERMINAL_FONT_FACE = `@font-face\{font-family:\$\{TERMINAL_FONT_FAMILY\};src:url\("data:font\/ttf;base64,[A-Za-z0-9+/=]{100000,}"\) format\("truetype"\)\}`/)
  assert.match(nativeTerminal, /<style>\$\{css\}\\n\$\{TERMINAL_FONT_FACE\}\$\{promptFont\}\\n\$\{textSizeAdjust\}html,body,#terminal\{/)
  assert.match(nativeTerminal, /const textSizeAdjust = Platform\.OS === 'ios' \? 'html\{-webkit-text-size-adjust:100%\}' : ''/)
  // xterm.js measures its cell once, when it opens: a page started before the font loaded keeps a fallback's width.
  assert.match(nativeTerminal, /const page = TERMINAL_FONT_FACE \? `document\.fonts\.load\('1em \$\{TERMINAL_FONT_FAMILY\}'\)\.finally\(function\(\)\{\$\{script\}\}\)` : script/)
})

test('iOS loads the terminal page over http, which WebKit lets open a ws:// socket', () => {
  assert.match(nativeTerminal, /const PAGE_URL = Platform\.OS === 'ios' \? 'http:\/\/agentsdock\.invalid\/' : 'https:\/\/agentsdock\.invalid\/'/)
  assert.match(nativeTerminal, /source=\{\{ html, baseUrl: PAGE_URL \}\}/)
  // react-native-webview compares origins, which have no trailing slash; on iOS a miss opened the page in Safari.
  assert.match(nativeTerminal, /originWhitelist=\{\[PAGE_URL\.slice\(0, -1\)\]\}/)
  assert.match(nativeTerminal, /request\.url === PAGE_URL \|\| request\.url === 'about:blank'/)
  for (const prop of ['keyboardDisplayRequiresUserAction={false}', 'hideKeyboardAccessoryView', 'contentMode="mobile"', 'onContentProcessDidTerminate={restartRenderer}']) {
    assert.ok(nativeTerminal.includes(prop), prop)
  }
})

test('terminal uses a full-screen modal without a sheet dismissal recognizer', () => {
  const terminalModal = shell.match(/\{modalScopeCurrent && terminal && selected && !isWelcomeSession\(selected\.id\) \? <Modal visible[\s\S]*?<\/Modal> : null\}/)?.[0] ?? ''
  assert.match(terminalModal, /presentationStyle="fullScreen"/)
  assert.doesNotMatch(terminalModal, /allowSwipeDismissal/)
  assert.match(terminalModal, /paddingTop:\s*fullscreenModalTopPadding\(insets, Platform\.OS\)/)
  assert.match(terminalModal, /edges=\{\['right', 'bottom', 'left'\]\}/)
})

test('mobile terminal sends typed input as binary frames and has a key row', () => {
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

test('the committed mobile terminal page bundle matches its sources', () => {
  execFileSync(process.execPath, ['scripts/embed-xterm.mjs', '--check'], { stdio: 'pipe' })
})

test('mobile terminal page is bundled into the HTML rather than written inline in the template', () => {
  // An inline script in the template literal needed every control escape doubled: a single-backslash
  // \x00 became a raw NUL in the generated HTML and truncated it (build 33/34).
  assert.match(nativeTerminal, /const script = escapeClosingTag\(TERMINAL_PAGE_JS, 'script'\)/)
  assert.match(nativeTerminal, /<script>\$\{page\}<\/script>/)
  assert.doesNotMatch(nativeTerminal, /\\x[0-9a-fA-F]{2}/)
})

test('the key row stays above the soft keyboard inside the full-screen terminal modal', () => {
  // iOS windows never shrink for the keyboard; the "will" events move the row with it.
  assert.match(source, /Keyboard\.addListener\(ios \? 'keyboardWillShow' : 'keyboardDidShow'/)
  assert.match(source, /Keyboard\.addListener\(ios \? 'keyboardWillHide' : 'keyboardDidHide', \(\) => setKeyboardOverlap\(0\)\)/)
  assert.match(source, /measureInWindow\(\(_x, y, _width, height\) => \{\s*setKeyboardOverlap\(Math\.max\(0, Math\.round\(y \+ height - event\.endCoordinates\.screenY\)\)\)/)
  assert.match(source, /paddingBottom: keyboardOverlap/)
})

test('opened terminal tabs stay mounted and full size while hidden, up to the measured limit', () => {
  // A collapsed (display: none) web view would lose its size; a hidden tab stays laid out behind the one in front.
  assert.match(shell, /const KEPT_TERMINAL_TABS = 8/)
  assert.match(shell, /const terminalInFront = selectedSurface\?\.kind === 'terminal' && /)
  assert.match(shell, /<SurfaceScreen surface=\{surface\} active=\{front\}/)
  assert.match(shell, /hiddenTerminal: \{ opacity: 0 \}/)
  assert.match(source, /else if \(standalone\) updateTerminalStatus\(terminal\.id, \{ bell: true \}\)/)
})

test('the android terminal keyboard button raises the soft keyboard through a native field', () => {
  // Blink shows the keyboard only for a focus made by a user gesture in the page; injected script has none.
  // WebKit shows it for the page's own focus, so the field is Android's only.
  assert.match(nativeTerminal, /keyboardBridge\.current\?\.focus\(\)\s*\n\s*webView\.current\?\.requestFocus\(\)/)
  assert.match(nativeTerminal, /\{Platform\.OS === 'android' \? <TextInput\s*\n\s*ref=\{keyboardBridge\}/)
})

test('the mobile terminal keeps the desktop\'s replay and report rules byte for byte', () => {
  // Ports, not shared modules: the page is bundled on its own, so these tests keep the copies identical.
  const desktop = relative => fs.readFileSync(path.resolve('..', relative), 'utf8')
  const line = (source, name) => source.match(new RegExp(`^const ${name} = .*$`, 'm'))?.[0]
  const block = source => source.match(/^const REPLAYED_CSI_QUERIES[\s\S]*?^const REPLAYED_OSC_QUERIES = .*$/m)?.[0]
  const replay = desktop('electron/src/renderer/src/lib/terminal-replay.ts')
  const client = desktop('electron/src/main/server-client.ts')
  const surface = desktop('electron/src/renderer/src/components/TerminalSurface.tsx')
  assert.ok(line(replay, 'TRAILING_SEQUENCE') && line(client, 'TERMINAL_REPORTS') && block(surface))
  assert.equal(line(terminalProtocol, 'TRAILING_SEQUENCE'), line(replay, 'TRAILING_SEQUENCE'))
  assert.equal(line(terminalProtocol, 'TERMINAL_REPORTS'), line(client, 'TERMINAL_REPORTS'))
  assert.equal(block(terminalPage), block(surface))
  for (const name of ['TERMINAL_ACK_BYTES', 'TERMINAL_ACK_IDLE_MS', 'TERMINAL_INPUT_FRAME_BYTES', 'TERMINAL_PENDING_INPUT_BYTES']) {
    assert.equal(line(terminalProtocol, name), line(client, name), name)
  }
})

test('a hardware Control-C sends ETX on iOS, where WebKit reports it with the keyCode of Return', () => {
  // xterm.js sends a keydown with keyCode 13 as CR, so Control-C ran the command line instead of interrupting it.
  assert.match(terminalPage, /event\.ctrlKey && !event\.metaKey && !event\.shiftKey && event\.key\.toLowerCase\(\) === 'c' && event\.keyCode === 13/)
  assert.match(terminalPage, /term\.input\(event\.altKey \? '\\x1b\\x03' : '\\x03'\)/)
})
