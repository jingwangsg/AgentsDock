// The Android terminal web view: xterm.js and the terminal's WebSocket. Bundled by scripts/embed-xterm.mjs; the
// host is src/components/terminal/TerminalViewport.android.tsx. The desktop counterpart is
// electron/src/renderer/src/components/TerminalSurface.tsx, whose rules this follows.
import { Terminal, type IFunctionIdentifier } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { TerminalReplay, openTerminalConnection, type TerminalLink, type TerminalLinkState } from '../src/terminal/terminalProtocol'
import type { TerminalKeyName, TerminalPageApi, TerminalPageConfig, TerminalPageMessage, TerminalPageStatus } from '../src/terminal/terminalPage'

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(message: string): void }
    __agentsDockTerminalConfig: TerminalPageConfig
    __agentsDockTerminal?: TerminalPageApi
  }
}

// Queries a program sent before this attach. xterm.js answers them while it parses the replayed
// scrollback, and those answers would arrive at the shell as typed text.
const REPLAYED_CSI_QUERIES: IFunctionIdentifier[] = [
  { final: 'n' }, { prefix: '?', final: 'n' }, // DSR, CPR
  { final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' }, // DA1-3
  { prefix: '>', final: 'q' }, // XTVERSION
  { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }, // DECRQM
  { prefix: '?', final: 'u' }, // kitty keyboard flags
  { prefix: '?', final: 'S' }, // XTSMGRAPHICS (image addon)
]
const REPLAYED_DCS_QUERIES: IFunctionIdentifier[] = [{ intermediates: '$', final: 'q' }, { intermediates: '+', final: 'q' }] // DECRQSS, XTGETTCAP
const WINDOW_REPORT_REQUESTS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]) // CSI Ps t
const REPLAYED_OSC_QUERIES = [4, 10, 11, 12, 17, 19, 52] // colors and OSC 52, each queried with '?'

const KEY_TEXT: Partial<Record<TerminalKeyName, string>> = {
  escape: '\x1b', tab: '\t', enter: '\r', home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~', dash: '-', slash: '/', pipe: '|', tilde: '~',
}
const ARROWS: Partial<Record<TerminalKeyName, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' }

const config = window.__agentsDockTerminalConfig
const post = (message: TerminalPageMessage) => window.ReactNativeWebView?.postMessage(JSON.stringify(message))
const host = document.getElementById('terminal')!
const term = new Terminal({
  cursorBlink: true,
  fontFamily: config.fontFamily,
  fontSize: config.fontSize,
  scrollback: 10000,
  allowProposedApi: true,
  theme: { background: config.backgroundHex, foreground: config.foregroundHex, cursor: config.cursorHex, cursorAccent: config.backgroundHex, selectionBackground: config.selectionHex },
})
const fit = new FitAddon()
const replay = new TerminalReplay((data, parsed) => term.write(data, parsed))
term.loadAddon(fit)
term.open(host)

// Replayed queries. The parser asks the newest handler first, and these return true (consumed) only for an
// already answered query, so live ones are answered.
const stale = () => replay.staleQueries
for (const id of REPLAYED_CSI_QUERIES) term.parser.registerCsiHandler(id, stale)
term.parser.registerCsiHandler({ final: 't' }, params => stale() && WINDOW_REPORT_REQUESTS.has(Number(params[0])))
for (const id of REPLAYED_DCS_QUERIES) term.parser.registerDcsHandler(id, stale)
for (const ident of REPLAYED_OSC_QUERIES) term.parser.registerOscHandler(ident, data => stale() && data.split(';').includes('?'))

const focus = () => { term.focus(); term.textarea?.focus({ preventScroll: true }) }
const visibleText = () => {
  const buffer = term.buffer.active
  const start = Math.max(0, buffer.viewportY)
  const end = Math.min(buffer.length, start + term.rows)
  const lines: string[] = []
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index)
    if (line) lines.push(line.translateToString(true))
  }
  return lines.join('\n').trimEnd()
}
const modifiers = { ctrl: false, alt: false }
const reportModifiers = () => post({ type: 'modifiers', ctrl: modifiers.ctrl, alt: modifiers.alt })
const releaseModifiers = () => { modifiers.ctrl = false; modifiers.alt = false; reportModifiers() }
// A sticky Ctrl/Alt from the key row applies to the next single character, then releases.
const withModifiers = (text: string) => {
  if (text.length !== 1 || (!modifiers.ctrl && !modifiers.alt)) return text
  const ctrl = modifiers.ctrl, alt = modifiers.alt
  releaseModifiers()
  let out = text
  if (ctrl) {
    const code = text.toUpperCase().charCodeAt(0)
    if (code >= 0x40 && code <= 0x5f) out = String.fromCharCode(code & 0x1f)
    else if (text === ' ') out = '\x00'
  }
  return alt ? '\x1b' + out : out
}
const cursorKey = (letter: string) => {
  if (modifiers.ctrl || modifiers.alt) {
    const parameter = modifiers.ctrl && modifiers.alt ? '7' : modifiers.ctrl ? '5' : '3'
    releaseModifiers()
    return '\x1b[1;' + parameter + letter
  }
  return (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + letter
}
const key = (name: TerminalKeyName) => {
  focus()
  const arrow = ARROWS[name]
  if (arrow) return link.write(cursorKey(arrow))
  const text = KEY_TEXT[name]
  if (text != null) link.write(withModifiers(text))
}
const fitIfLaidOut = () => {
  // A view still being laid out can measure a few pixels; FitAddon would push its minimum grid to the shell.
  if (host.clientWidth >= 32 && host.clientHeight >= 32) fit.fit()
}

// The connection.
const STATUS: Record<TerminalLinkState['state'], TerminalPageStatus> = {
  connecting: 'Connecting', reconnecting: 'Reconnecting', connected: 'Connected', exited: 'Exited', error: 'Error',
}
// A viewer out of sight attaches passive: it neither sizes the pty nor holds the shell back for the others.
const passive = () => document.hidden
// A replay, after `ready` or a `resync`, rebuilds the screen. RIS goes through the write queue, so output still
// queued from before cannot land after it.
const startReplay = (replayBytes: number | null) => {
  replay.attach(replayBytes)
  term.write('\x1bc')
}
const connect = (): TerminalLink => openTerminalConnection({
  url: config.socketURL,
  standalone: config.standalone,
  columns: term.cols,
  rows: term.rows,
  passive,
  onState: state => {
    if (state.state === 'connected') {
      startReplay(state.replayBytes)
      fitIfLaidOut()
      // The server sized the pty from the connect request; a fit made while the link was opening never reached
      // it. A passive viewer leaves the size to the one in use.
      if (!passive()) link.resize(term.cols, term.rows)
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

window.__agentsDockTerminal = {
  focus,
  blur: () => term.blur(),
  paste: text => { focus(); term.paste(String(text ?? '')) },
  copy: requestId => post({ type: 'copy', requestId, text: term.getSelection() || visibleText() }),
  key,
  modifier: (name, active) => { if (name in modifiers) { modifiers[name] = !!active; reportModifiers() } },
  restart: () => {
    link.close()
    link = connect()
  },
}
host.addEventListener('pointerdown', focus)
host.addEventListener('touchstart', () => requestAnimationFrame(focus), { passive: true })
new ResizeObserver(fitIfLaidOut).observe(document.body)
window.addEventListener('beforeunload', () => {
  link.close()
  term.dispose()
})
// The app coming back to the front sends the size once, which makes this device the one that sizes the pty.
document.addEventListener('visibilitychange', () => {
  if (!passive()) link.resize(term.cols, term.rows)
})
if (config.exited) post({ type: 'status', status: 'Exited' })
