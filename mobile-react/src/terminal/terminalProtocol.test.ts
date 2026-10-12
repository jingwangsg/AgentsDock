import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { TerminalReplay, openTerminalConnection, terminalKeyAction, trailingSequencesStart, type TerminalLinkState } from './terminalProtocol'

// Same cases as the desktop suite (electron/src/renderer/src/lib/terminal-replay.test.ts).
test('trailingSequencesStart takes a new shell’s whole startup probe as still waiting', () => {
  const fishProbe = '\x1b[?u\x1b[>0q\x1b]11;?\x1b\\\x1b[?1049h\x1bP+q696e646e\x1b\\\x1b[?1049l\x1b[0c'
  assert.equal(trailingSequencesStart(fishProbe), 0)
  assert.equal(trailingSequencesStart(`hello\r\n${fishProbe}`), 7)
  // It ends at the last output, so queries that more output followed were answered.
  assert.equal(trailingSequencesStart(`${fishProbe}\r\n❮ `), fishProbe.length + 4)
  assert.equal(trailingSequencesStart('a\x1b[c b\x1b[0m\x1b]0;title\x07'), 6)
  assert.equal(trailingSequencesStart(''), 0)
})

// Same cases as the desktop's non-macOS chords (electron/src/renderer/src/lib/terminal-input.test.ts).
test('terminalKeyAction keeps Control-letters for the shell and moves the terminal commands to Control-Shift', () => {
  const key = (key: string, modifiers: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {}, code = '') => ({
    key, code, metaKey: Boolean(modifiers.meta), ctrlKey: Boolean(modifiers.ctrl), altKey: Boolean(modifiers.alt), shiftKey: Boolean(modifiers.shift),
  })
  for (const letter of ['c', 'v', 'a', 'k', 'l', 'f', 'w']) assert.equal(terminalKeyAction(key(letter, { ctrl: true }, `Key${letter.toUpperCase()}`)), null, letter)
  assert.equal(terminalKeyAction(key('C', { ctrl: true, shift: true }, 'KeyC')), 'copy')
  assert.equal(terminalKeyAction(key('V', { ctrl: true, shift: true }, 'KeyV')), 'paste')
  assert.equal(terminalKeyAction(key('A', { ctrl: true, shift: true }, 'KeyA')), 'select-all')
  assert.equal(terminalKeyAction(key('K', { ctrl: true, shift: true }, 'KeyK')), 'clear')
  assert.equal(terminalKeyAction(key('F', { ctrl: true, shift: true }, 'KeyF')), 'find')
  assert.equal(terminalKeyAction(key('W', { ctrl: true, shift: true }, 'KeyW')), 'close')
  assert.equal(terminalKeyAction(key('ArrowUp', { ctrl: true, shift: true })), 'previous-prompt')
  assert.equal(terminalKeyAction(key('ArrowDown', { ctrl: true, shift: true })), 'next-prompt')
  assert.equal(terminalKeyAction(key('=', { ctrl: true })), 'zoom-in')
  assert.equal(terminalKeyAction(key('-', { ctrl: true })), 'zoom-out')
  assert.equal(terminalKeyAction(key('0', { ctrl: true })), 'zoom-reset')
  assert.equal(terminalKeyAction(key('ArrowLeft', { meta: true })), null)
  assert.equal(terminalKeyAction(key('ArrowLeft', { alt: true })), null)
  assert.equal(terminalKeyAction(key('Tab', { shift: true })), null)
  assert.equal(terminalKeyAction(key('C', { ctrl: true, shift: true })), 'copy', 'a key event without a scan code has no `code`')
  assert.equal(terminalKeyAction(key('c', { ctrl: true })), null)
})

function fakeTerminal() {
  const writes: { data: string; parsed?: () => void }[] = []
  return { writes, write: (data: string, parsed?: () => void) => { writes.push({ data, parsed }) } }
}

test('a replay keeps its queries unanswered until its trailing escape sequences and suppresses side effects to its end', () => {
  const terminal = fakeTerminal()
  const replay = new TerminalReplay(terminal.write)
  const text = 'old\x1b[6n output\r\n$ \x1b[c'
  replay.attach(Buffer.byteLength(text))
  assert.equal(replay.replaying, true)
  assert.equal(replay.staleQueries, true)
  replay.data(text, Buffer.byteLength(text))
  assert.deepEqual(terminal.writes.map(write => write.data), ['old\x1b[6n output\r\n$ ', '\x1b[c'])
  terminal.writes[0].parsed!()
  assert.equal(replay.staleQueries, false, 'the trailing device-attributes probe is answered')
  assert.equal(replay.replaying, true, 'a bell in the trailing part is still replayed output')
  terminal.writes[1].parsed!()
  assert.equal(replay.replaying, false)
  replay.data('live', 4)
  assert.deepEqual(terminal.writes.at(-1), { data: 'live', parsed: undefined })
})

test('an older attach’s replay that finishes late does not end a newer one’s suppression', () => {
  const terminal = fakeTerminal()
  const replay = new TerminalReplay(terminal.write)
  replay.attach(3)
  replay.data('one', 3)
  replay.attach(3)
  for (const write of terminal.writes) write.parsed?.()
  assert.equal(replay.staleQueries, true)
  assert.equal(replay.replaying, true)
  replay.data('two', 3)
  for (const write of terminal.writes.slice(1)) write.parsed?.()
  assert.equal(replay.replaying, false)
})

test('a server without replay_bytes replays in its first data; an empty replay suppresses nothing', () => {
  const terminal = fakeTerminal()
  const replay = new TerminalReplay(terminal.write)
  replay.attach(null)
  assert.equal(replay.replaying, true)
  replay.data('screen\x1b[6n', 10)
  assert.equal(terminal.writes[0].data, 'screen')
  terminal.writes[0].parsed!()
  terminal.writes[1].parsed!()
  replay.data('next', 4)
  assert.equal(terminal.writes.at(-1)!.parsed, undefined)
  replay.attach(0)
  assert.equal(replay.replaying, false)
  assert.equal(replay.staleQueries, false)
})

class FakeSocket extends EventTarget {
  static sockets: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  sent: (string | Uint8Array)[] = []
  constructor(readonly url: string) {
    super()
    FakeSocket.sockets.push(this)
  }
  send(data: string | Uint8Array) { this.sent.push(typeof data === 'string' ? data : Uint8Array.from(data)) }
  close() { this.readyState = 3 }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  text(data: string) { this.dispatchEvent(new MessageEvent('message', { data })) }
  binary(bytes: number | Uint8Array) {
    this.dispatchEvent(new MessageEvent('message', { data: (typeof bytes === 'number' ? new Uint8Array(bytes).fill(0x61) : bytes).buffer }))
  }
  closed(code: number, reason = '') {
    this.readyState = 3
    const event = new Event('close') as Event & { code: number; reason: string }
    event.code = code
    event.reason = reason
    this.dispatchEvent(event)
  }
}

function connect(standalone: boolean) {
  FakeSocket.sockets = []
  const states: TerminalLinkState[] = []
  const data: [string, number][] = []
  const resyncs: number[] = []
  const link = openTerminalConnection({
    url: 'ws://127.0.0.1:7850/api/sessions/term_1/terminal/ws?columns=100&rows=30&token=t',
    standalone,
    columns: 80,
    rows: 24,
    onState: state => { states.push(state) },
    onResync: bytes => { resyncs.push(bytes) },
    onData: (text, bytes) => { data.push([text, bytes]) },
    createSocket: url => new FakeSocket(url) as unknown as WebSocket,
  })
  return { link, states, data, resyncs, socket: () => FakeSocket.sockets.at(-1)! }
}

const acks = (socket: FakeSocket) => socket.sent.filter(item => typeof item === 'string' && item.includes('"ack"')).map(item => JSON.parse(item as string).bytes)

test('a terminal tab opts in to flow control and acknowledges its replay at once, then every 16 KiB', () => {
  const { socket, states } = connect(true)
  const url = new URL(socket().url)
  assert.equal(url.searchParams.get('flow_control'), '1')
  assert.equal(url.searchParams.get('columns'), '80')
  assert.equal(url.searchParams.get('rows'), '24')
  socket().open()
  socket().text(JSON.stringify({ type: 'ready', name: 'fish', replay_bytes: 500 }))
  assert.deepEqual(states.at(-1), { state: 'connected', name: 'fish', replayBytes: 500 })
  socket().binary(500)
  assert.deepEqual(acks(socket()), [500])
  for (let index = 0; index < 5; index += 1) socket().binary(4096)
  assert.deepEqual(acks(socket()), [500, 16_384])
})

test('a chat terminal neither asks for flow control nor acknowledges', () => {
  const { socket, data } = connect(false)
  assert.equal(new URL(socket().url).searchParams.get('flow_control'), null)
  socket().open()
  socket().text(JSON.stringify({ type: 'ready', name: 'tmux' }))
  socket().binary(40_000)
  assert.deepEqual(acks(socket()), [])
  assert.equal(data[0][1], 40_000)
})

test('input waits for ready in order, answers to the old connection’s queries are dropped, and frames stay at 64 KiB', () => {
  const { link, socket } = connect(true)
  link.write('ls')
  link.write('\x1b[12;1R\x1b[?62;22c')
  link.write('\r')
  assert.deepEqual(socket().sent, [])
  socket().open()
  socket().text(JSON.stringify({ type: 'ready', replay_bytes: 0 }))
  assert.deepEqual(socket().sent.map(frame => Buffer.from(frame as Uint8Array).toString()), ['ls', '\r'])
  link.write('x'.repeat(100 * 1024))
  assert.deepEqual(socket().sent.slice(2).map(frame => (frame as Uint8Array).byteLength), [64 * 1024, 36 * 1024])
  link.write('\x1b[1;1R')
  assert.equal(Buffer.from(socket().sent.at(-1) as Uint8Array).toString(), '\x1b[1;1R', 'a live answer is sent')
  link.writeBinary('\x1b[M\xa0\xa1')
  assert.deepEqual([...(socket().sent.at(-1) as Uint8Array)], [0x1b, 0x5b, 0x4d, 0xa0, 0xa1])
})

test('an open socket is not timed out, a stalled viewer reconnects at the current size, an exited shell is not restarted', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { link, socket, states } = connect(true)
    const first = socket()
    first.open()
    mock.timers.tick(11_000)
    assert.equal(socket(), first, 'the connect watchdog ends when the socket opens')
    first.text(JSON.stringify({ type: 'ready', replay_bytes: 0 }))
    link.resize(120, 40)
    assert.equal(first.sent.at(-1), JSON.stringify({ type: 'resize', columns: 120, rows: 40 }))
    first.closed(1013, 'terminal output not acknowledged')
    assert.deepEqual(states.at(-1), { state: 'reconnecting', error: 'terminal output not acknowledged' })
    link.write('typed meanwhile')
    mock.timers.tick(1_000)
    const second = socket()
    assert.notEqual(second, first)
    assert.equal(new URL(second.url).searchParams.get('columns'), '120')
    second.open()
    second.text(JSON.stringify({ type: 'ready', replay_bytes: 0 }))
    assert.equal(Buffer.from(second.sent[0] as Uint8Array).toString(), 'typed meanwhile')
    second.closed(4410)
    assert.deepEqual(states.at(-1), { state: 'exited' })
    mock.timers.tick(20_000)
    assert.equal(socket(), second)
  } finally {
    mock.timers.reset()
  }
})

test('a tab attaches passive, and a resync replay is acknowledged at once and decoded afresh', () => {
  const { link, socket, data, resyncs } = connect(true)
  assert.equal(new URL(socket().url).searchParams.get('passive'), '1')
  socket().open()
  socket().text(JSON.stringify({ type: 'ready', replay_bytes: 0 }))
  // Live output ends inside a character; the resync replay that follows starts a new stream.
  socket().binary(Uint8Array.of(0x61, 0xe2, 0x9d))
  socket().text(JSON.stringify({ type: 'resync', replay_bytes: 3 }))
  socket().binary(Uint8Array.of(0x62, 0x63, 0x64))
  assert.deepEqual(resyncs, [3])
  assert.deepEqual(data.map(([text]) => text), ['a', 'bcd'])
  assert.deepEqual(acks(socket()), [6], 'the replay is acknowledged at once, with the live bytes still unacknowledged')
  link.close()
})

test('a batch short of 16 KiB is acknowledged within 200 ms of its first byte, even while output keeps coming', () => {
  // A spinner's acknowledgements keep advancing, so the server never takes this viewer as asleep; and a viewer
  // the server held back for falling behind gets its resync.
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { link, socket } = connect(true)
    socket().open()
    socket().text(JSON.stringify({ type: 'ready', replay_bytes: 0 }))
    socket().binary(1000)
    mock.timers.tick(100)
    socket().binary(500)
    mock.timers.tick(99)
    assert.deepEqual(acks(socket()), [])
    mock.timers.tick(1)
    assert.deepEqual(acks(socket()), [1500])
    socket().binary(50)
    mock.timers.tick(200)
    assert.deepEqual(acks(socket()), [1500, 50])
    link.close()
  } finally {
    mock.timers.reset()
  }
})
