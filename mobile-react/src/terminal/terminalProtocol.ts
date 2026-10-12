// The Android terminal page's rules for its WebSocket, the server's replay and hardware-keyboard chords.
// Ports of the desktop's, kept identical so both clients treat a terminal the same way:
// - trailingSequencesStart: electron/src/renderer/src/lib/terminal-replay.ts
// - TerminalReplay and the REPLAYED_* query lists in scripts/terminal-page-entry.ts: the replay handling in
//   electron/src/renderer/src/components/TerminalSurface.tsx
// - openTerminalConnection: terminal() and reconnectingSocket() in electron/src/main/server-client.ts
// - terminalKeyAction: the non-macOS chords of electron/src/renderer/src/lib/terminal-input.ts

/** WebSocket close code the server uses when the shell itself ended, as opposed to a dropped link. */
const TERMINAL_SHELL_EXITED_CLOSE_CODE = 4410
// A terminal tab acknowledges output in batches of this size, and its replay as soon as it arrives (until
// then the server allows a viewer 1 s more per 8 KiB of replay before closing it as stalled). The server
// pauses the shell while the active viewer has more than its window of live output
// (TERMINAL_OUTPUT_WINDOW_BYTES, 128 KiB) unacknowledged.
const TERMINAL_ACK_BYTES = 16 * 1024
// A batch still short of that size is acknowledged once output has paused this long: a viewer the server
// holds back for falling behind gets its resync only when every byte it was sent is acknowledged.
const TERMINAL_ACK_IDLE_MS = 200
// Input frames stay far below the 1 MiB frame limit of chat terminals and older servers, and small enough
// that acknowledgements get through between the frames of a large paste on a slow link.
const TERMINAL_INPUT_FRAME_BYTES = 64 * 1024
// Input typed while the terminal (re)connects waits for `ready`, up to the 1 MiB an older server takes in
// one frame; beyond that it is dropped.
const TERMINAL_PENDING_INPUT_BYTES = 1024 * 1024
// Answers a terminal gives to a program's queries: cursor position and status, device attributes, mode,
// window and keyboard-flag reports, OSC colour replies, DCS replies. One written while the terminal is
// (re)connecting answers the old connection's query and would reach the program seconds later as typed
// text, so it is not kept. Shift/Ctrl/Alt+F3 (ESC[1;<mod>R) reads the same as a cursor position report.
const TERMINAL_REPORTS = /^(?:\x1b\[\??[\d;]*[Rn]|\x1b\[[?>=][\d;]*c|\x1b\[\??[\d;]*\$y|\x1b\[\?\d*u|\x1b\[[\d;]*t|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/
const TERMINAL_CONNECT_TIMEOUT_MS = 10_000

type TerminalControl = { type?: string; name?: string; message?: string; replay_bytes?: unknown }

const replayByteCount = (control: TerminalControl) => typeof control.replay_bytes === 'number' ? control.replay_bytes : null

// An escape sequence at the end of a string: CSI, OSC or DCS/APC/PM/SOS strings, or a two-byte ESC.
const TRAILING_SEQUENCE = /(?:\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x1b]*\x1b\\|\x1b[\x20-\x7e])$/

/**
 * Where the run of escape sequences that ends a replayed scrollback begins. Queries before it were
 * followed by more output, so the program already had its answer; queries in it may still be
 * waiting, like the device-attributes probe a shell sends before its first prompt.
 */
export function trailingSequencesStart(data: string): number {
  let end = data.length
  for (let match = TRAILING_SEQUENCE.exec(data.slice(0, end)); match; match = TRAILING_SEQUENCE.exec(data.slice(0, end))) {
    end = match.index
  }
  return end
}

/**
 * One terminal's replay handling across attaches. The server replays the shell's scrollback on every
 * attach: its bells, notifications and clipboard writes already happened once, and xterm.js would answer
 * its queries again while parsing it, as typed text at the shell.
 */
export class TerminalReplay {
  /** True while this attach's replay is parsed. */
  replaying = false
  /** True while the part of the replay before its trailing escape sequences is parsed: the program had those answers. */
  staleQueries = false
  // Counts attaches, so a replay that finishes after a newer attach began cannot end that one's.
  private attachCount = 0
  // Bytes of this attach's replay still to come; null: a server that does not report it, whose first data is the replay.
  private replayLeft: number | null = 0

  /** `write` is xterm.js's: `parsed` runs once the terminal has parsed `data`. */
  constructor(private readonly write: (data: string, parsed?: () => void) => void) {}

  attach(replayBytes: number | null): void {
    this.attachCount += 1
    this.replayLeft = replayBytes
    this.replaying = this.staleQueries = replayBytes !== 0
  }

  data(text: string, byteLength: number): void {
    if (this.replayLeft === 0) {
      this.write(text)
      return
    }
    this.replayLeft = this.replayLeft === null ? 0 : Math.max(0, this.replayLeft - byteLength)
    if (this.replayLeft > 0) {
      this.write(text)
      return
    }
    const attach = this.attachCount
    const pending = trailingSequencesStart(text)
    const tail = text.slice(pending)
    this.write(text.slice(0, pending), () => {
      if (this.attachCount !== attach) return
      this.staleQueries = false
      if (!tail) this.replaying = false
    })
    if (tail) this.write(tail, () => { if (this.attachCount === attach) this.replaying = false })
  }
}

export type TerminalLinkState =
  | { state: 'connecting' | 'reconnecting'; error?: string }
  | { state: 'connected'; name?: string; replayBytes: number | null }
  /** The shell ended (close code 4410); the next connect starts a new one. */
  | { state: 'exited' }
  | { state: 'error'; error: string }

export interface TerminalLink {
  /** Typed text and xterm.js's answers, UTF-8 encoded. */
  write(data: string): void
  /** xterm.js's binary output (X10 mouse reports past column 95): one byte per character. */
  writeBinary(data: string): void
  resize(columns: number, rows: number): void
  close(): void
}

interface TerminalLinkOptions {
  /** The terminal WebSocket URL; the current size is set on every attempt. */
  url: string
  standalone: boolean
  columns: number
  rows: number
  onState(state: TerminalLinkState): void
  /**
   * A viewer that is not the active one and fell behind gets no live output until it has acknowledged
   * everything, then a fresh replay of this many bytes in the next binary frame, as after `ready`.
   */
  onResync(replayBytes: number): void
  /** Output in order, decoded across frames; `byteLength` counts the frame's bytes (0 for a text frame). */
  onData(text: string, byteLength: number): void
  createSocket?(url: string): WebSocket
}

/**
 * The page's terminal WebSocket: connect, retry with a doubling backoff (500 ms to 10 s, jitter below
 * min(250, delay / 3)) and a 10 s connect watchdog; acknowledge a terminal tab's output; send input in
 * frames of at most 64 KiB once the server said `ready`, keeping what is typed meanwhile in order.
 */
export function openTerminalConnection(options: TerminalLinkOptions): TerminalLink {
  const createSocket = options.createSocket ?? (url => new WebSocket(url))
  const encoder = new TextEncoder()
  let columns = options.columns
  let rows = options.rows
  let stopped = false
  let socket: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let retryDelay = 500
  let attempt = 0
  // Per socket: input is sent once the server said `ready`; terminal tabs acknowledge output.
  let decoder = new TextDecoder()
  let ready = false
  let replayPending = false
  let unacknowledged = 0
  let ackTimer: ReturnType<typeof setTimeout> | null = null
  // Input typed while no socket is ready, carried across reconnects.
  const pendingInput: Uint8Array<ArrayBuffer>[] = []
  let pendingInputBytes = 0

  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = null
  }
  const acknowledge = (current: WebSocket) => {
    if (ackTimer) clearTimeout(ackTimer)
    ackTimer = null
    if (unacknowledged && socket === current && current.readyState === WebSocket.OPEN) current.send(JSON.stringify({ type: 'ack', bytes: unacknowledged }))
    unacknowledged = 0
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    if (retry) clearTimeout(retry)
    retry = null
    if (ackTimer) clearTimeout(ackTimer)
    clearWatchdog()
    socket?.close()
  }
  const disconnect = (error?: string) => {
    if (stopped || !socket) return
    socket = null
    clearWatchdog()
    options.onState({ state: 'reconnecting', ...(error ? { error } : {}) })
    const jitter = Math.floor(Math.random() * Math.min(250, retryDelay / 3))
    retry = setTimeout(connect, retryDelay + jitter)
    retryDelay = Math.min(10_000, retryDelay * 2)
  }
  const receive = (bytes: Uint8Array, current: WebSocket) => {
    if (!bytes.byteLength) return
    options.onData(decoder.decode(bytes, { stream: true }), bytes.byteLength)
    if (!options.standalone) return
    unacknowledged += bytes.byteLength
    if (unacknowledged >= TERMINAL_ACK_BYTES || replayPending) acknowledge(current)
    else {
      if (ackTimer) clearTimeout(ackTimer)
      ackTimer = setTimeout(() => acknowledge(current), TERMINAL_ACK_IDLE_MS)
    }
    replayPending = false
  }
  const send = (bytes: Uint8Array<ArrayBuffer>) => {
    const open = ready && socket?.readyState === WebSocket.OPEN
    for (let start = 0; start < bytes.byteLength; start += TERMINAL_INPUT_FRAME_BYTES) {
      const frame = bytes.subarray(start, start + TERMINAL_INPUT_FRAME_BYTES)
      if (open) socket!.send(frame)
      else if (pendingInputBytes + frame.byteLength <= TERMINAL_PENDING_INPUT_BYTES) {
        pendingInput.push(frame)
        pendingInputBytes += frame.byteLength
      }
    }
  }

  const connect = () => {
    if (stopped) return
    retry = null
    options.onState({ state: attempt++ === 0 ? 'connecting' : 'reconnecting' })
    const url = new URL(options.url)
    url.searchParams.set('columns', String(columns))
    url.searchParams.set('rows', String(rows))
    if (options.standalone) url.searchParams.set('flow_control', '1')
    // A tab takes the pty's size when the user shows it or types in it (terminal-page-entry.ts), not by reconnecting.
    if (options.standalone) url.searchParams.set('passive', '1')
    decoder = new TextDecoder()
    ready = false
    replayPending = false
    unacknowledged = 0
    if (ackTimer) clearTimeout(ackTimer)
    const current = createSocket(url.toString())
    current.binaryType = 'arraybuffer'
    socket = current
    watchdog = setTimeout(() => {
      if (stopped || socket !== current) return
      current.close()
      disconnect('Terminal connection timed out')
    }, TERMINAL_CONNECT_TIMEOUT_MS)
    current.addEventListener('open', () => {
      if (!stopped && socket === current) clearWatchdog()
    })
    current.addEventListener('message', message => {
      if (stopped || socket !== current) return
      if (typeof message.data !== 'string') {
        receive(new Uint8Array(message.data as ArrayBuffer), current)
        return
      }
      let control: TerminalControl | null = null
      try {
        control = JSON.parse(message.data) as TerminalControl
      } catch {
        // Not a control message: an older server's text output.
      }
      if (control?.type === 'ready') {
        retryDelay = 500
        ready = true
        replayPending = (replayByteCount(control) ?? 0) > 0
        for (const frame of pendingInput.splice(0)) current.send(frame)
        pendingInputBytes = 0
        options.onState({ state: 'connected', name: control.name, replayBytes: replayByteCount(control) })
      } else if (control?.type === 'resync') {
        // The replay starts a new stream: bytes the decoder held back belong to output that was skipped.
        decoder = new TextDecoder()
        replayPending = (replayByteCount(control) ?? 0) > 0
        options.onResync(replayByteCount(control) ?? 0)
      } else if (control?.type === 'error') {
        // Unmarked server control errors can be transient (a tmux attach race during a managed restart);
        // only the 44xx close codes below are durable.
        disconnect(control.message || 'Terminal connection failed')
        current.close()
      } else if (!control) {
        options.onData(message.data, 0)
      }
    })
    current.addEventListener('close', event => {
      if (stopped || socket !== current) return
      const tail = decoder.decode()
      if (tail) options.onData(tail, 0)
      if (event.code === TERMINAL_SHELL_EXITED_CLOSE_CODE) {
        stop()
        options.onState({ state: 'exited' })
        return
      }
      if (event.code === 4401 || event.code === 4404 || event.code === 4406 || event.code === 4409) {
        stop()
        options.onState({
          state: 'error',
          error: event.code === 4401
            ? 'Terminal authorization failed'
            : event.code === 4404
              ? options.standalone ? 'This terminal tab is gone from the server, or the AgentsServer is too old for terminal tabs.' : 'Chat not found'
              : event.code === 4406
                ? 'Terminal protocol was rejected'
                : 'Unarchive this chat before opening its terminal.',
        })
        return
      }
      disconnect(event.reason || undefined)
    })
    current.addEventListener('error', () => {
      if (stopped || socket !== current) return
      current.close()
      disconnect('Terminal connection interrupted')
    })
  }

  connect()
  return {
    write(data) {
      if (stopped) return
      if (!(ready && socket?.readyState === WebSocket.OPEN) && TERMINAL_REPORTS.test(data)) return
      send(encoder.encode(data))
    },
    writeBinary(data) {
      if (stopped) return
      send(Uint8Array.from(data, char => char.charCodeAt(0) & 0xff))
    },
    resize(nextColumns, nextRows) {
      if (stopped) return
      columns = nextColumns
      rows = nextRows
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', columns, rows }))
    },
    close: stop,
  }
}

export type TerminalCommand =
  | 'copy' | 'paste' | 'select-all' | 'clear' | 'find' | 'close'
  | 'zoom-in' | 'zoom-out' | 'zoom-reset'
  | 'previous-prompt' | 'next-prompt'

type KeyInput = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/**
 * A hardware keyboard's terminal commands. Control-letters belong to the shell, so the terminal's own
 * commands take Control-Shift, as in GNOME Terminal and Windows Terminal. Null leaves the key to xterm.js.
 */
export function terminalKeyAction(event: KeyInput): TerminalCommand | null {
  const { metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift } = event
  // The web view leaves `code` empty for key events without a scan code (injected ones, some keyboards).
  const code = event.code || (/^[a-z]$/i.test(event.key) ? `Key${event.key.toUpperCase()}` : '')
  if (ctrl && shift && !alt && !meta) {
    if (code === 'KeyC') return 'copy'
    if (code === 'KeyV') return 'paste'
    if (code === 'KeyA') return 'select-all'
    if (code === 'KeyK') return 'clear'
    if (code === 'KeyF') return 'find'
    if (code === 'KeyW') return 'close'
    if (event.key === 'ArrowUp') return 'previous-prompt'
    if (event.key === 'ArrowDown') return 'next-prompt'
    if (event.key === '+') return 'zoom-in'
  }
  if (ctrl && !shift && !alt && !meta) {
    if (event.key === '=') return 'zoom-in'
    if (event.key === '-') return 'zoom-out'
    if (event.key === '0') return 'zoom-reset'
  }
  return null
}
