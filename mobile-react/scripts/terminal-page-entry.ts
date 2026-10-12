// The Android terminal web view: xterm.js, its addons and the terminal's WebSocket. Bundled by
// scripts/embed-xterm.mjs; the host is src/components/terminal/TerminalViewport.android.tsx. The desktop
// counterpart is electron/src/renderer/src/components/TerminalSurface.tsx, whose rules this follows.
import { Terminal, type IFunctionIdentifier, type IMarker, type ITerminalOptions } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { TerminalReplay, openTerminalConnection, terminalKeyAction, type TerminalCommand, type TerminalLink, type TerminalLinkState } from '../src/terminal/terminalProtocol'
import { clampTerminalFontSize, type TerminalKeyName, type TerminalPageApi, type TerminalPageConfig, type TerminalPageMessage, type TerminalPageOptions, type TerminalPageStatus } from '../src/terminal/terminalPage'

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void }
    __agentsDockTerminalConfig: TerminalPageConfig
    __agentsDockTerminal?: TerminalPageApi
  }
}

// Queries a program sent before this attach. xterm.js answers them while it parses the replayed
// scrollback, and those answers would arrive at the shell as typed text. Copied byte for byte from the
// desktop's TerminalSurface.tsx (tests/terminal-layout.test.mjs compares them).
const REPLAYED_CSI_QUERIES: IFunctionIdentifier[] = [
  { final: 'n' }, { prefix: '?', final: 'n' }, // DSR, CPR
  { final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' }, // DA1-3
  { prefix: '>', final: 'q' }, // XTVERSION
  { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }, // DECRQM
  { prefix: '?', final: 'u' }, // kitty keyboard flags
  { prefix: '?', final: 'S' } // XTSMGRAPHICS (image addon)
]
const REPLAYED_DCS_QUERIES: IFunctionIdentifier[] = [{ intermediates: '$', final: 'q' }, { intermediates: '+', final: 'q' }] // DECRQSS, XTGETTCAP
const WINDOW_REPORT_REQUESTS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]) // CSI Ps t
const REPLAYED_OSC_QUERIES = [4, 10, 11, 12, 17, 19, 52] // colors and OSC 52, each queried with '?'
// A finger that moved less than this is still a tap, which xterm.js receives as a click.
const TOUCH_SLOP_PX = 8

const KEY_TEXT: Partial<Record<TerminalKeyName, string>> = {
  escape: '\x1b', tab: '\t', backtab: '\x1b[Z', enter: '\r', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~',
  dash: '-', slash: '/', pipe: '|', tilde: '~',
}
const ARROWS: Partial<Record<TerminalKeyName, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' }
// xterm's encodings: F1–F4 are SS3 P–S, with modifiers CSI 1;m P–S; the rest are CSI n ~ or CSI n;m ~.
const FUNCTION_KEYS: Partial<Record<TerminalKeyName, string>> = {
  f1: 'P', f2: 'Q', f3: 'R', f4: 'S', f5: '15', f6: '17', f7: '18', f8: '19', f9: '20', f10: '21', f11: '23', f12: '24',
}

const config = window.__agentsDockTerminalConfig
const post = (message: TerminalPageMessage) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))
const host = document.getElementById('terminal')!
let options = config.options
// In front of the user: shown by the host, and the app not in the background.
let shown = config.visible
const selectLayer = document.createElement('div')
selectLayer.id = 'select-layer'
selectLayer.style.fontFamily = config.fontFamily
document.body.appendChild(selectLayer)

function openLink(uri: string): void {
  if (/^https?:\/\//i.test(uri)) post({ type: 'link', uri })
}

function xtermOptions(next: TerminalPageOptions): ITerminalOptions {
  return {
    fontSize: clampTerminalFontSize(next.fontSize),
    cursorStyle: next.cursorStyle,
    cursorBlink: next.cursorBlink,
    scrollback: next.scrollback,
    screenReaderMode: next.screenReader,
  }
}

function applyTheme(): void {
  term.options.theme = {
    background: options.background, foreground: options.foreground, cursor: options.cursor, cursorAccent: options.background, selectionBackground: options.selection,
  }
  document.documentElement.style.background = options.background
  selectLayer.style.color = options.foreground
  selectLayer.style.background = options.background
}

const term = new Terminal({
  ...xtermOptions(options),
  allowProposedApi: true,
  fontFamily: config.fontFamily,
  linkHandler: { activate: (_event, uri) => openLink(uri), allowNonHttpProtocols: false },
})
const fit = new FitAddon()
const search = new SearchAddon()
const replay = new TerminalReplay((data, parsed) => term.write(data, parsed))
term.loadAddon(fit)
term.loadAddon(search)
term.loadAddon(new Unicode11Addon())
term.unicode.activeVersion = '11'
term.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri)))
// A phone's web view is killed well before the addon's 128 MB default of decoded images.
term.loadAddon(new ImageAddon({ storageLimit: 32 }))
// OSC 52: programs may write the clipboard, never read it (the answer is empty).
term.loadAddon(new ClipboardAddon(undefined, {
  readText: () => '',
  writeText: (_selection, text) => { if (!replay.replaying) post({ type: 'clipboard', text }) },
}))
term.open(host)
// WebGL, as on the desktop: on the emulator (2026-10-12) its web view process used 0.4 s of CPU per 30 s with a
// blinking cursor against the DOM renderer's 1.2 s, and the same for a 150,000-line burst.
try {
  const webgl = new WebglAddon()
  // A lost GPU context (a GPU reset, the system reclaiming it) falls back to the DOM renderer.
  webgl.onContextLoss(() => webgl.dispose())
  term.loadAddon(webgl)
} catch {
  // No WebGL2: xterm.js keeps its DOM renderer.
}
applyTheme()

// Replayed queries. Registered after the addons: the parser asks the newest handler first, and
// these return true (consumed) only for an already answered query, so live ones are answered.
const stale = () => replay.staleQueries
for (const id of REPLAYED_CSI_QUERIES) term.parser.registerCsiHandler(id, stale)
term.parser.registerCsiHandler({ final: 't' }, params => stale() && WINDOW_REPORT_REQUESTS.has(Number(params[0])))
for (const id of REPLAYED_DCS_QUERIES) term.parser.registerDcsHandler(id, stale)
for (const ident of REPLAYED_OSC_QUERIES) term.parser.registerOscHandler(ident, data => stale() && data.split(';').includes('?'))

// Shell status: OSC 0/2 title and OSC 7 working directory name the tab; a bell reaches the host.
term.onTitleChange(title => post({ type: 'title', title: title.trim() || null }))
term.parser.registerOscHandler(7, data => {
  try {
    const url = new URL(data)
    if (url.protocol === 'file:') post({ type: 'cwd', cwd: decodeURIComponent(url.pathname) })
  } catch {
    // Not a file URL: nothing to track.
  }
  return true
})
let lastBell = 0
term.onBell(() => {
  const now = Date.now()
  if (replay.replaying || now - lastBell < 200) return
  lastBell = now
  post({ type: 'bell' })
})
// Notifications (OSC 9, OSC 777). The host posts them while the app is not in front: it learns that at
// once, while a call into this page waits until the app is back in front.
const notify = (title: string, body: string) => {
  if (!replay.replaying) post({ type: 'notify', title, body })
}
// iTerm2's OSC 9 message; ConEmu reuses OSC 9 with a numeric first field (progress), which is not one.
term.parser.registerOscHandler(9, data => {
  if (/^\d+(;|$)/.test(data)) return false
  notify('', data)
  return true
})
// urxvt/foot/Ghostty: OSC 777;notify;<title>;<body>
term.parser.registerOscHandler(777, data => {
  const [kind, title = '', ...body] = data.split(';')
  if (kind !== 'notify') return false
  notify(title, body.join(';'))
  return true
})
// OSC 133 prompt marks. A reset (RIS) keeps markers on the lines it erased, so each attach drops them.
// Only observes, so it returns false and leaves the sequence to any other handler.
let prompts: IMarker[] = []
term.parser.registerOscHandler(133, data => {
  if (data.startsWith('A')) {
    const marker = term.registerMarker(0)
    if (marker) prompts = [...prompts.filter(item => !item.isDisposed), marker]
  }
  return false
})
const jumpPrompt = (direction: 'previous' | 'next') => {
  // A prompt is scrolled to the top line. Prompts below the top line are already on screen, so
  // "previous" goes to the first one above it, and "next" past the last one returns to the bottom.
  const top = term.buffer.active.viewportY
  const lines = prompts.filter(marker => !marker.isDisposed).map(marker => marker.line)
  const target = direction === 'previous' ? lines.findLast(line => line < top) : lines.find(line => line > top)
  if (target !== undefined) term.scrollToLine(target)
  else if (direction === 'next') term.scrollToBottom()
}

// Hardware keyboards: Control-Shift chords run terminal commands, everything else is xterm.js's.
const runCommand = (command: TerminalCommand) => {
  switch (command) {
    case 'copy': if (term.hasSelection()) post({ type: 'clipboard', text: term.getSelection() }); break
    case 'select-all': term.selectAll(); break
    case 'clear': term.clear(); break
    case 'previous-prompt': jumpPrompt('previous'); break
    case 'next-prompt': jumpPrompt('next'); break
    default: post({ type: 'command', command })
  }
}
term.attachCustomKeyEventHandler(event => {
  const command = terminalKeyAction(event)
  if (!command) return true
  if (event.type === 'keydown') {
    event.preventDefault()
    runCommand(command)
  }
  return false
})
// Copy on select copies what a mouse (or a double tap) selected, not a find match or Select All.
let mouseSelecting = false
host.addEventListener('mousedown', event => { if (event.button === 0) mouseSelecting = true }, true)
// xterm.js reports the selection from its own mouseup listener, which runs before this timer.
window.addEventListener('mouseup', () => { if (mouseSelecting) setTimeout(() => { mouseSelecting = false }) })
term.onSelectionChange(() => {
  if (mouseSelecting && options.copyOnSelect && term.hasSelection()) post({ type: 'clipboard', text: term.getSelection() })
})

// The key row's sticky Ctrl/Alt apply to the next single character, then release.
const modifiers = { ctrl: false, alt: false }
const reportModifiers = () => post({ type: 'modifiers', ctrl: modifiers.ctrl, alt: modifiers.alt })
const takeModifiers = () => {
  const taken = { ...modifiers }
  if (taken.ctrl || taken.alt) {
    modifiers.ctrl = modifiers.alt = false
    reportModifiers()
  }
  return taken
}
const withModifiers = (text: string) => {
  if (text.length !== 1 || (!modifiers.ctrl && !modifiers.alt)) return text
  const { ctrl, alt } = takeModifiers()
  let out = text
  if (ctrl) {
    const code = text.toUpperCase().charCodeAt(0)
    if (code >= 0x40 && code <= 0x5f) out = String.fromCharCode(code & 0x1f)
    else if (text === ' ') out = '\x00'
  }
  return alt ? `\x1b${out}` : out
}
// xterm's modifier parameter: 1 + (Shift 1, Alt 2, Ctrl 4).
const modifierParameter = () => {
  const { ctrl, alt } = takeModifiers()
  return 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0)
}
const keySequence = (name: TerminalKeyName): string | null => {
  const arrow = ARROWS[name]
  if (arrow) {
    const parameter = modifierParameter()
    if (parameter > 1) return `\x1b[1;${parameter}${arrow}`
    return (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + arrow
  }
  const functionKey = FUNCTION_KEYS[name]
  if (functionKey) {
    const parameter = modifierParameter()
    if (/^[PQRS]$/.test(functionKey)) return parameter > 1 ? `\x1b[1;${parameter}${functionKey}` : `\x1bO${functionKey}`
    return parameter > 1 ? `\x1b[${functionKey};${parameter}~` : `\x1b[${functionKey}~`
  }
  const text = KEY_TEXT[name]
  return text == null ? null : withModifiers(text)
}

// Touch: a vertical drag scrolls the scrollback; in the alternate screen, or for a program that tracks
// the mouse, it becomes wheel events, which xterm.js turns into arrow keys or the program's wheel
// reports. A tap reaches xterm.js as a click (a mouse report for such a program, or a link). Two fingers
// pinch the font size.
type Gesture =
  | { kind: 'pending' | 'scroll'; startY: number; lastY: number; carry: number }
  | { kind: 'pinch'; startDistance: number; startSize: number; size: number }
let gesture: Gesture | null = null
const fingerDistance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
const scrollByTouch = (lines: number, touch: Touch) => {
  if (term.modes.mouseTrackingMode === 'none' && term.buffer.active.type === 'normal') {
    term.scrollLines(lines)
    return
  }
  const screen = host.querySelector('.xterm-screen')
  for (let count = Math.abs(lines); count > 0; count -= 1) {
    screen?.dispatchEvent(new WheelEvent('wheel', {
      deltaY: Math.sign(lines), deltaMode: WheelEvent.DOM_DELTA_LINE, clientX: touch.clientX, clientY: touch.clientY, bubbles: true, cancelable: true,
    }))
  }
}
host.addEventListener('touchstart', event => {
  if (event.touches.length === 2) {
    const size = term.options.fontSize ?? options.fontSize
    gesture = { kind: 'pinch', startDistance: fingerDistance(event.touches), startSize: size, size }
    event.preventDefault()
  } else if (event.touches.length === 1) {
    const touch = event.touches[0]
    gesture = { kind: 'pending', startY: touch.clientY, lastY: touch.clientY, carry: 0 }
    // xterm.js looks up the link under the pointer only when the pointer reaches another cell, and two taps on
    // the same cell have no move between them: a move to the row's far end first makes the tap look again.
    const screen = host.querySelector('.xterm-screen')
    if (screen && term.modes.mouseTrackingMode === 'none') {
      const bounds = screen.getBoundingClientRect()
      const nearLeft = touch.clientX - bounds.left < bounds.width / term.cols
      screen.dispatchEvent(new MouseEvent('mousemove', { clientX: nearLeft ? bounds.right + 1 : bounds.left - 1, clientY: touch.clientY, bubbles: true }))
    }
  }
}, { passive: false, capture: true })
host.addEventListener('touchmove', event => {
  if (!gesture) return
  if (gesture.kind === 'pinch') {
    if (event.touches.length < 2) return
    event.preventDefault()
    const size = clampTerminalFontSize(gesture.startSize * fingerDistance(event.touches) / gesture.startDistance)
    if (size !== gesture.size) {
      gesture.size = size
      term.options.fontSize = size
      fitIfLaidOut()
    }
    return
  }
  const touch = event.touches[0]
  if (gesture.kind === 'pending') {
    if (Math.abs(touch.clientY - gesture.startY) < TOUCH_SLOP_PX) return
    gesture.kind = 'scroll'
    gesture.lastY = touch.clientY
  }
  event.preventDefault()
  gesture.carry += touch.clientY - gesture.lastY
  gesture.lastY = touch.clientY
  const cell = (host.querySelector('.xterm-screen')?.clientHeight ?? 0) / term.rows || 16
  const lines = Math.trunc(gesture.carry / cell)
  if (!lines) return
  gesture.carry -= lines * cell
  // A finger moving down shows earlier lines.
  scrollByTouch(-lines, touch)
}, { passive: false, capture: true })
const endTouch = (event: TouchEvent) => {
  if (event.touches.length) return
  if (gesture?.kind === 'pinch') post({ type: 'font-size', fontSize: gesture.size })
  gesture = null
}
host.addEventListener('touchend', endTouch, { capture: true })
host.addEventListener('touchcancel', endTouch, { capture: true })

// Select text: the buffer as plain text over the terminal, where the web view's own long press,
// handles and Copy menu work (xterm.js has no touch selection). Starts at the terminal's top line.
const selectText = (on: boolean) => {
  window.getSelection()?.removeAllRanges()
  if (!on) {
    selectLayer.style.display = 'none'
    selectLayer.textContent = ''
    return
  }
  term.blur()
  const buffer = term.buffer.active
  let text = ''
  let topOffset = 0
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index)
    if (!line) continue
    if (index === buffer.viewportY) topOffset = line.isWrapped ? text.lastIndexOf('\n') + 1 : text.length + (index ? 1 : 0)
    // A wrapped row continues the line above; its trailing blanks are part of the text.
    const next = buffer.getLine(index + 1)
    const row = line.translateToString(!next?.isWrapped)
    text += index && !line.isWrapped ? `\n${row}` : row
  }
  selectLayer.textContent = `${text.trimEnd()}\n`
  selectLayer.style.fontSize = `${term.options.fontSize}px`
  selectLayer.style.display = 'block'
  const node = selectLayer.firstChild
  if (node) {
    const range = document.createRange()
    range.setStart(node, Math.min(topOffset, node.textContent?.length ?? 0))
    selectLayer.scrollTop = range.getBoundingClientRect().top - selectLayer.getBoundingClientRect().top - 8
  }
}

const focus = () => {
  term.focus()
  term.textarea?.focus({ preventScroll: true })
}
const fitIfLaidOut = () => {
  // A view still being laid out can measure a few pixels; FitAddon would push its minimum grid to the shell.
  if (host.clientWidth >= 32 && host.clientHeight >= 32) fit.fit()
}
const STATUS: Record<TerminalLinkState['state'], TerminalPageStatus> = {
  connecting: 'Connecting', reconnecting: 'Reconnecting', connected: 'Connected', exited: 'Exited', error: 'Error',
}
// Every attach is passive. A tab out of sight leaves the pty's size, and so the active viewer, to the device in use.
const outOfSight = () => !shown || document.hidden
// A replay, after `ready` or a `resync`, rebuilds the screen. RIS goes through the write queue, so output still
// queued from before cannot land after it.
const startReplay = (replayBytes: number | null) => {
  replay.attach(replayBytes)
  term.write('\x1bc', () => {
    for (const marker of prompts) marker.dispose()
    prompts = []
  })
}
const connect = (): TerminalLink => openTerminalConnection({
  url: config.socketURL,
  standalone: config.standalone,
  columns: term.cols,
  rows: term.rows,
  onState: state => {
    if (state.state === 'connected') {
      startReplay(state.replayBytes)
      fitIfLaidOut()
      // In front of the user, this device takes the pty's size, which a fit made while the link was down never
      // sent. Not on a resync: that arrives on a live connection and leaves the size alone.
      if (!outOfSight()) link.resize(term.cols, term.rows)
    }
    post({
      type: 'status',
      status: STATUS[state.state],
      ...(state.state === 'connected' && state.name ? { name: state.name } : {}),
      ...('error' in state && state.error ? { message: state.error } : {}),
    })
  },
  onResync: startReplay,
  onData: (text, byteLength) => replay.data(text, byteLength),
})
// The first attempt asks for the size the view has now. A shell that exited stays exited until restart().
fitIfLaidOut()
// load-bearing: onState reads `link` only for `connected`, which arrives after this assignment.
let link: TerminalLink = config.exited ? { write() {}, writeBinary() {}, resize() {}, close() {} } : connect()
term.onData(data => link.write(withModifiers(data)))
term.onBinary(data => link.writeBinary(data))
term.onResize(({ cols, rows }) => link.resize(cols, rows))

// A hidden tab keeps reading its output but draws nothing: with the terminal out of the layout, xterm.js pauses
// its renderer until it is shown again.
const setDisplay = () => {
  host.style.display = shown ? '' : 'none'
  if (shown) fitIfLaidOut()
}
// A tab that comes into sight sends its size once, which makes this device the one that sizes the pty.
const claimSize = (wasOutOfSight: boolean) => {
  if (wasOutOfSight && !outOfSight()) link.resize(term.cols, term.rows)
}

window.__agentsDockTerminal = {
  focus,
  blur: () => term.blur(),
  paste: text => {
    focus()
    term.paste(String(text ?? ''))
  },
  copy: requestId => {
    // Without a selection: the lines on screen.
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let index = buffer.viewportY; index < Math.min(buffer.length, buffer.viewportY + term.rows); index += 1) {
      const line = buffer.getLine(index)
      if (line) lines.push(line.translateToString(true))
    }
    post({ type: 'copy', requestId, text: term.getSelection() || lines.join('\n').trimEnd() })
  },
  key: name => {
    focus()
    const sequence = keySequence(name)
    if (sequence) link.write(sequence)
  },
  modifier: (name, active) => {
    if (!(name in modifiers)) return
    modifiers[name] = active
    reportModifiers()
  },
  configure: next => {
    const resized = next.fontSize !== options.fontSize
    options = next
    Object.assign(term.options, xtermOptions(next))
    applyTheme()
    if (resized) fitIfLaidOut()
  },
  find: (query, findOptions, direction, incremental) => {
    if (!query) return
    // The search addon takes #RRGGBB only.
    const decorations: ISearchOptions['decorations'] = options.dark
      ? { matchBackground: '#5c4a12', matchOverviewRuler: '#d4a72c', activeMatchBackground: '#a87800', activeMatchColorOverviewRuler: '#ffc83d' }
      : { matchBackground: '#fff2a8', matchOverviewRuler: '#d4a72c', activeMatchBackground: '#ffc83d', activeMatchColorOverviewRuler: '#bf8700' }
    const searchOptions: ISearchOptions = { ...findOptions, incremental, decorations }
    try {
      if (direction > 0) search.findNext(query, searchOptions)
      else search.findPrevious(query, searchOptions)
    } catch {
      // An unfinished regular expression matches nothing yet.
      search.clearDecorations()
      post({ type: 'find-results', index: -1, count: 0 })
    }
  },
  clearFind: () => search.clearDecorations(),
  jumpPrompt,
  selectText,
  setVisible: on => {
    const wasOutOfSight = outOfSight()
    shown = on
    setDisplay()
    claimSize(wasOutOfSight)
  },
  restart: () => {
    link.close()
    link = connect()
  },
}
search.onDidChangeResults(event => post({ type: 'find-results', index: event.resultIndex, count: event.resultCount }))
host.addEventListener('pointerdown', event => { if (event.pointerType !== 'touch') focus() })
host.addEventListener('click', focus)
new ResizeObserver(fitIfLaidOut).observe(document.body)
window.addEventListener('beforeunload', () => {
  link.close()
  term.dispose()
})
// The app coming back to the front with this tab shown.
let hiddenPage = document.hidden
document.addEventListener('visibilitychange', () => {
  claimSize(!shown || hiddenPage)
  hiddenPage = document.hidden
})
setDisplay()
if (config.exited) post({ type: 'status', status: 'Exited' })
post({ type: 'ready' })

