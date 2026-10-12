import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Surface } from '@shared/types'
import { updateTerminalSettings } from '../lib/terminal-settings'
import { useAppStore } from '../store/app-store'
import { SurfaceStack } from './SurfacePane'
import { TerminalSurface } from './TerminalSurface'

const xterm = vi.hoisted(() => ({
  instances: [] as Array<Record<string, any>>,
  addons: [] as Array<Record<string, any>>
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    modes = { mouseTrackingMode: 'none' }
    unicode = { activeVersion: '6' }
    buffer = { active: { viewportY: 0, baseY: 0, cursorY: 0 } }
    writes: string[] = []
    pendingWriteCallbacks: Array<() => void> = []
    osc = new Map<number, (data: string) => boolean>()
    listeners: Record<string, (value?: any) => void> = {}
    markers: Array<{ line: number; isDisposed: boolean }> = []
    parser = { registerOscHandler: (ident: number, handler: (data: string) => boolean) => { this.osc.set(ident, handler); return { dispose() {} } } }
    keyHandler: (event: KeyboardEvent) => boolean = () => true
    focus = vi.fn()
    clear = vi.fn()
    paste = vi.fn()
    selectAll = vi.fn()
    scrollToLine = vi.fn((line: number) => { this.buffer.active.viewportY = Math.min(line, this.buffer.active.baseY) })
    scrollToBottom = vi.fn(() => { this.buffer.active.viewportY = this.buffer.active.baseY })
    hasSelection = vi.fn(() => false)
    getSelection = vi.fn(() => '')
    dispose = vi.fn()
    loadAddon = vi.fn((addon: Record<string, any>) => xterm.addons.push(addon))
    open = vi.fn()
    constructor(options: Record<string, unknown>) {
      this.options = { ...options }
      xterm.instances.push(this)
    }
    write(data: string, callback?: () => void) {
      this.writes.push(data)
      if (callback) this.pendingWriteCallbacks.push(callback)
    }
    finishWrites() { for (const callback of this.pendingWriteCallbacks.splice(0)) callback() }
    input(data: string, wasUserInput = false) { if (wasUserInput) this.listeners.data?.(data) }
    registerMarker() { const marker = { line: this.buffer.active.baseY + this.buffer.active.cursorY, isDisposed: false }; this.markers.push(marker); return marker }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.keyHandler = handler }
    on(name: string) { return (listener: (value?: any) => void) => { this.listeners[name] = listener; return { dispose: vi.fn() } } }
    onData = this.on('data')
    onBinary = this.on('binary')
    onResize = this.on('resize')
    onTitleChange = this.on('title')
    onBell = this.on('bell')
    onSelectionChange = this.on('selection')
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { kind = 'fit'; fit = vi.fn() } }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class {
    kind = 'search'
    findNext = vi.fn(() => true)
    findPrevious = vi.fn(() => true)
    clearDecorations = vi.fn()
    resultsListener: ((event: { resultIndex: number; resultCount: number }) => void) | null = null
    onDidChangeResults = (listener: (event: { resultIndex: number; resultCount: number }) => void) => { this.resultsListener = listener; return { dispose: vi.fn() } }
  }
}))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class { kind = 'unicode11' } }))
vi.mock('@xterm/addon-image', () => ({ ImageAddon: class { kind = 'image' } }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { kind = 'webgl'; onContextLoss = vi.fn(); dispose = vi.fn() } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class { kind = 'links'; constructor(public handler: (event: MouseEvent, uri: string) => void) {} } }))
vi.mock('@xterm/addon-clipboard', () => ({
  ClipboardAddon: class { kind = 'clipboard'; constructor(_base64: unknown, public provider: { readText: () => string; writeText: (selection: string, text: string) => void }) {} }
}))

const surface: Surface = { id: 'term_abc', kind: 'terminal', name: null, folder: 'General', cwd: '/work/app', url: null, page_title: null, created_at: '', updated_at: '' }
type Listener = (payload: any) => void
let listeners: Record<string, Listener[]>
let terminalApi: { connect: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
let native: { writeClipboard: ReturnType<typeof vi.fn>; readClipboard: ReturnType<typeof vi.fn>; openExternal: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> }

beforeEach(() => {
  xterm.instances.length = 0
  xterm.addons.length = 0
  listeners = {}
  localStorage.clear()
  updateTerminalSettings({})
  terminalApi = {
    connect: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    resize: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined)
  }
  native = {
    writeClipboard: vi.fn().mockResolvedValue(undefined),
    readClipboard: vi.fn().mockResolvedValue('echo one\necho two\n'),
    openExternal: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined)
  }
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      terminal: terminalApi,
      native,
      files: { pathForFile: (file: File) => `/Users/me/${file.name}` },
      events: { on: (name: string, listener: Listener) => { (listeners[name] ??= []).push(listener); return () => { listeners[name] = listeners[name].filter(item => item !== listener) } } }
    } as unknown as AgentsDockAPI
  })
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  useAppStore.setState({
    activeProfileId: 'profile-a',
    profileGeneration: 4,
    profiles: [{ id: 'profile-a', name: 'Local', serverUrl: 'http://127.0.0.1:7850', serverIdentity: 'server-a', hasAccessToken: false, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0 }],
    surfaces: [surface],
    selectedSurfaceId: surface.id
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const emit = (name: string, payload: Record<string, unknown>) => act(() => { for (const listener of listeners[name] ?? []) listener({ profileId: 'profile-a', profileGeneration: 4, sessionId: surface.id, ...payload }) })
const addon = (kind: string) => xterm.addons.find(item => item.kind === kind)!
const keydown = (patch: Partial<KeyboardEvent>) => {
  const event = { type: 'keydown', key: 'a', code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn(), ...patch }
  return { event, handled: !xterm.instances[0].keyHandler(event as unknown as KeyboardEvent) }
}
async function openConnected(active = true) {
  const view = render(<TerminalSurface surface={surface} active={active} />)
  await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
  emit('terminal:state', { state: 'connected', name: 'zsh' })
  const terminal = xterm.instances[0]
  emit('terminal:data', { data: 'replayed scrollback' })
  act(() => terminal.finishWrites())
  return { view, terminal }
}

describe('TerminalSurface', () => {
  it('opens its terminal and shell the first time the tab is shown, then keeps them while hidden', async () => {
    const view = render(<TerminalSurface surface={surface} active={false} />)
    await act(async () => { await Promise.resolve() })
    expect(xterm.instances).toHaveLength(0)
    expect(terminalApi.connect).not.toHaveBeenCalled()

    view.rerender(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledWith('profile-a', 4, 'term_abc', { cwd: '/work/app', columns: 80, rows: 24 }))
    const [terminal] = xterm.instances
    expect(terminal.open).toHaveBeenCalledOnce()
    expect(terminal.options).toMatchObject({ scrollback: 10_000, macOptionIsMeta: false, macOptionClickForcesSelection: true, cursorStyle: 'bar', screenReaderMode: false })
    expect(terminal.unicode.activeVersion).toBe('11')
    expect(xterm.addons.map(item => item.kind).sort()).toEqual(['clipboard', 'fit', 'image', 'links', 'search', 'unicode11', 'webgl'])

    view.rerender(<TerminalSurface surface={surface} active={false} />)
    await act(async () => { await Promise.resolve() })
    expect(terminalApi.disconnect).not.toHaveBeenCalled()
    expect(terminal.dispose).not.toHaveBeenCalled()
    expect(terminalApi.connect).toHaveBeenCalledTimes(1)
  })

  it('attaches only the shown tab of several', async () => {
    const other = { ...surface, id: 'term_other' }
    useAppStore.setState({ surfaces: [surface, other] })
    render(<SurfaceStack surfaces={[surface, other]} selectedId={surface.id} sidebarVisible onSidebarToggle={() => undefined} />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    expect(terminalApi.connect.mock.calls[0][2]).toBe('term_abc')
    expect(xterm.instances).toHaveLength(1)
  })

  it('relays bytes both ways and rebuilds the screen from the replay on every attach', async () => {
    render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    const [terminal] = xterm.instances
    expect(screen.getByRole('status')).toHaveTextContent('Starting shell…')

    emit('terminal:state', { state: 'connected', name: 'zsh' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(terminal.focus).toHaveBeenCalled()
    // RIS through the write queue, before the replayed scrollback.
    expect(terminal.writes).toEqual(['\x1bc'])

    emit('terminal:data', { data: 'héllo ' })
    emit('terminal:data', { data: '中文\r\n' })
    expect(terminal.writes).toEqual(['\x1bc', 'héllo ', '中文\r\n'])

    act(() => terminal.listeners.data('ls\r'))
    expect(terminalApi.write).toHaveBeenCalledWith('profile-a', 4, 'term_abc', 'ls\r')
    act(() => terminal.listeners.binary('\x1b[M !!'))
    expect(terminalApi.write).toHaveBeenCalledWith('profile-a', 4, 'term_abc', '\x1b[M !!')
    act(() => terminal.listeners.resize({ cols: 100, rows: 30 }))
    expect(terminalApi.resize).toHaveBeenCalledWith('profile-a', 4, 'term_abc', 100, 30)

    // Bytes for another tab or profile never reach this terminal.
    emit('terminal:data', { data: 'other', sessionId: 'term_other' })
    emit('terminal:data', { data: 'stale', profileGeneration: 3 })
    expect(terminal.writes).toHaveLength(3)
  })

  it('gives the shell the visible grid once attached, since a resize sent while the link was opening was lost', async () => {
    render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    const [terminal] = xterm.instances
    terminal.cols = 148
    terminal.rows = 57
    terminalApi.resize.mockClear()

    emit('terminal:state', { state: 'connected', name: 'fish' })
    expect(terminalApi.resize).toHaveBeenCalledWith('profile-a', 4, 'term_abc', 148, 57)
  })

  it('does not repeat the replay’s clipboard writes, bells or notifications', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const { terminal } = await openConnected()
    emit('terminal:state', { state: 'connected', name: 'zsh' })
    emit('terminal:data', { data: '\x1b]52;c;b2xk\x07\x07\x1b]9;old\x07' })
    const clipboard = addon('clipboard').provider
    act(() => {
      clipboard.writeText('c', 'old')
      terminal.listeners.bell()
      terminal.osc.get(9)('old')
    })
    expect(native.writeClipboard).not.toHaveBeenCalled()
    expect(native.notify).not.toHaveBeenCalled()

    act(() => terminal.finishWrites())
    act(() => {
      clipboard.writeText('c', 'new')
      terminal.osc.get(9)('build finished')
    })
    expect(native.writeClipboard).toHaveBeenCalledWith('new')
    // Reads get an empty answer instead of the clipboard.
    expect(clipboard.readText('c')).toBe('')
    expect(native.notify).toHaveBeenCalledWith({
      title: 'Terminal', body: 'build finished', profileId: 'profile-a', serverIdentity: 'server-a', sessionId: 'term_abc', surface: true
    })
  })

  it('posts OSC 777 notifications and marks a bell only while the tab is out of sight', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { terminal } = await openConnected()
    act(() => {
      terminal.osc.get(777)('notify;Deploy;done; all green')
      terminal.listeners.bell()
    })
    expect(native.notify).not.toHaveBeenCalled()
    expect(terminal.osc.get(9)('4;1;50')).toBe(false)

    act(() => terminal.listeners.title('vim notes.md'))
    hasFocus.mockReturnValue(false)
    act(() => terminal.osc.get(777)('notify;Deploy;done; all green'))
    expect(native.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Deploy', body: 'done; all green', surface: true }))
    act(() => terminal.osc.get(9)('tests passed'))
    expect(native.notify).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'vim notes.md', body: 'tests passed' }))
  })

  it('shows the shell title and directory in the tab header until the user renames it', async () => {
    render(<SurfaceStack surfaces={[surface]} selectedId={surface.id} sidebarVisible onSidebarToggle={() => undefined} />)
    await waitFor(() => expect(xterm.instances).toHaveLength(1))
    const [terminal] = xterm.instances
    act(() => {
      terminal.listeners.title('htop')
      terminal.osc.get(7)('file://mac.local/Users/me/My%20Project')
    })
    const title = screen.getByRole('textbox', { name: 'Rename htop' })
    expect(title).toHaveValue('htop')
    expect(screen.getByText('me / My Project')).toBeInTheDocument()
    // Focusing and leaving the field does not turn the live title into a rename.
    const updateSurface = vi.fn().mockResolvedValue(true)
    useAppStore.setState({ updateSurface } as never)
    act(() => { title.focus(); title.blur() })
    expect(updateSurface).not.toHaveBeenCalled()
  })

  it('offers a new shell after the shell exits and reuses the same terminal for it', async () => {
    render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    emit('terminal:state', { state: 'connected' })
    emit('terminal:state', { state: 'disconnected', error: null })

    expect(screen.getByRole('status')).toHaveTextContent('The shell exited.')
    await userEvent.setup().click(screen.getByRole('button', { name: 'New shell' }))

    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(2))
    expect(terminalApi.disconnect).toHaveBeenCalledTimes(1)
    expect(xterm.instances).toHaveLength(1)
    expect(xterm.instances[0].dispose).not.toHaveBeenCalled()
    emit('terminal:state', { state: 'connected' })
    expect(xterm.instances[0].writes.filter((data: string) => data === '\x1bc')).toHaveLength(2)
  })

  it('shows the server error with a retry when the connection fails', async () => {
    render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    emit('terminal:state', { state: 'error', error: 'This AgentsServer is too old for standalone terminals. Update it, then open the terminal again.' })
    expect(screen.getByRole('status')).toHaveTextContent('too old for standalone terminals')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('runs the terminal’s ⌘ chords itself and leaves the app’s chords to the menu', async () => {
    const { terminal } = await openConnected()

    let key = keydown({ key: 'c', metaKey: true })
    expect(key.handled).toBe(true)
    expect(key.event.preventDefault).toHaveBeenCalled()
    expect(native.writeClipboard).not.toHaveBeenCalled()
    terminal.hasSelection.mockReturnValue(true)
    terminal.getSelection.mockReturnValue('selected text')
    keydown({ key: 'c', metaKey: true })
    expect(native.writeClipboard).toHaveBeenCalledWith('selected text')

    keydown({ key: 'v', metaKey: true })
    await waitFor(() => expect(terminal.paste).toHaveBeenCalledWith('echo one\necho two\n'))
    keydown({ key: 'k', metaKey: true })
    expect(terminal.clear).toHaveBeenCalledOnce()
    keydown({ key: 'a', metaKey: true })
    expect(terminal.selectAll).toHaveBeenCalledOnce()

    keydown({ key: 'ArrowLeft', metaKey: true })
    keydown({ key: 'Backspace', metaKey: true })
    keydown({ key: 'ArrowRight', altKey: true })
    expect(terminalApi.write.mock.calls.map(call => call[3])).toEqual(['\x01', '\x15', '\x1bf'])

    key = keydown({ key: 'r', metaKey: true })
    expect(key.handled).toBe(false)
    expect(key.event.preventDefault).not.toHaveBeenCalled()
    expect(keydown({ key: 'l', ctrlKey: true }).handled).toBe(false)
    // The keyup of a handled chord is not given to xterm.js either.
    expect(terminal.keyHandler({ type: 'keyup', key: 'k', metaKey: true } as KeyboardEvent)).toBe(false)
  })

  it('zooms one tab with ⌘+/⌘−/⌘0 on top of the font size setting, which applies live', async () => {
    const { terminal } = await openConnected()
    expect(terminal.options.fontSize).toBe(13)
    act(() => { keydown({ key: '=', metaKey: true }); keydown({ key: '=', metaKey: true }) })
    expect(terminal.options.fontSize).toBe(15)
    act(() => updateTerminalSettings({ fontSize: 16, cursorStyle: 'block', optionAsMeta: true, scrollback: 50_000 }))
    expect(terminal.options).toMatchObject({ fontSize: 18, cursorStyle: 'block', macOptionIsMeta: true, scrollback: 50_000 })
    act(() => { keydown({ key: '0', metaKey: true }) })
    expect(terminal.options.fontSize).toBe(16)
    act(() => { keydown({ key: '-', metaKey: true }) })
    expect(terminal.options.fontSize).toBe(15)
  })

  it('jumps between OSC 133 prompts with ⌘↑ and ⌘↓', async () => {
    const { terminal } = await openConnected()
    const buffer = terminal.buffer.active
    for (const line of [3, 40, 102]) {
      Object.assign(buffer, { baseY: line, cursorY: 0 })
      terminal.osc.get(133)('A;click_events=1')
    }
    terminal.osc.get(133)('B')
    Object.assign(buffer, { baseY: 100, viewportY: 100, cursorY: 5 })

    keydown({ key: 'ArrowUp', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(102)
    // That prompt is on the last screen, so the view stays at the bottom and the next jump continues from it.
    expect(buffer.viewportY).toBe(100)
    keydown({ key: 'ArrowUp', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(40)
    keydown({ key: 'ArrowUp', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(3)
    keydown({ key: 'ArrowUp', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(3)
    keydown({ key: 'ArrowDown', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(40)
    // A manual scroll in between restarts from the view's top line.
    buffer.viewportY = 20
    keydown({ key: 'ArrowDown', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(40)
    keydown({ key: 'ArrowDown', metaKey: true })
    keydown({ key: 'ArrowDown', metaKey: true })
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce()
  })

  it('opens ⌘-clicked links in the browser and ignores plain clicks', async () => {
    const { terminal } = await openConnected()
    addon('links').handler(new MouseEvent('click'), 'https://example.com/a')
    expect(native.openExternal).not.toHaveBeenCalled()
    addon('links').handler(new MouseEvent('click', { metaKey: true }), 'https://example.com/a')
    expect(native.openExternal).toHaveBeenCalledWith('https://example.com/a')
    // OSC 8 hyperlinks take the same path.
    ;(terminal.options.linkHandler as { activate: (event: MouseEvent, uri: string) => void }).activate(new MouseEvent('click', { metaKey: true }), 'https://example.com/osc8')
    expect(native.openExternal).toHaveBeenLastCalledWith('https://example.com/osc8')
    expect((terminal.options.linkHandler as { allowNonHttpProtocols: boolean }).allowNonHttpProtocols).toBe(false)
  })

  it('copies on select only when the setting is on', async () => {
    const { terminal } = await openConnected()
    terminal.hasSelection.mockReturnValue(true)
    terminal.getSelection.mockReturnValue('word')
    act(() => terminal.listeners.selection())
    expect(native.writeClipboard).not.toHaveBeenCalled()
    act(() => updateTerminalSettings({ copyOnSelect: true }))
    act(() => terminal.listeners.selection())
    expect(native.writeClipboard).toHaveBeenCalledWith('word')
  })

  it('offers Copy, Paste, Select All, Clear and Find on right click, unless a program tracks the mouse', async () => {
    const { view, terminal } = await openConnected()
    const host = view.container.querySelector('.terminal-surface-host')!
    fireEvent.contextMenu(host, { clientX: 20, clientY: 20 })
    const copy = await screen.findByRole('menuitem', { name: 'Copy' })
    expect(copy).toHaveAttribute('data-disabled')
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Copy', 'Paste', 'Select All', 'Clear', 'Find…'])
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Paste' }))
    await waitFor(() => expect(terminal.paste).toHaveBeenCalledWith('echo one\necho two\n'))

    fireEvent.contextMenu(host, { clientX: 20, clientY: 20 })
    await userEvent.setup().click(await screen.findByRole('menuitem', { name: 'Find…' }))
    expect(await screen.findByRole('search')).toBeInTheDocument()

    terminal.modes.mouseTrackingMode = 'vt200'
    await userEvent.setup().keyboard('{Escape}')
    fireEvent.contextMenu(host, { clientX: 20, clientY: 20 })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.contextMenu(host, { clientX: 20, clientY: 20, altKey: true })
    expect(await screen.findByRole('menu')).toBeInTheDocument()
  })

  it('searches the scrollback from the Find menu command with case, word and regex options', async () => {
    await openConnected()
    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:find-active-surface', { cancelable: true })) })
    const input = await screen.findByRole('textbox', { name: 'Find' })
    const search = addon('search')
    await userEvent.setup().type(input, 'err')
    expect(search.findNext).toHaveBeenLastCalledWith('err', expect.objectContaining({ incremental: true, caseSensitive: false, regex: false, wholeWord: false }))
    act(() => search.resultsListener({ resultIndex: 1, resultCount: 7 }))
    expect(screen.getByText('2 of 7')).toBeInTheDocument()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Use regular expression' }))
    expect(search.findNext).toHaveBeenLastCalledWith('err', expect.objectContaining({ regex: true }))
    await userEvent.setup().keyboard('{Shift>}{Enter}{/Shift}')
    expect(search.findPrevious).toHaveBeenLastCalledWith('err', expect.objectContaining({ regex: true, incremental: false }))
    search.findNext.mockImplementationOnce(() => { throw new SyntaxError('Invalid regular expression') })
    await userEvent.setup().type(input, '(')
    expect(screen.getByText('No results')).toBeInTheDocument()

    await userEvent.setup().keyboard('{Escape}')
    expect(screen.queryByRole('search')).not.toBeInTheDocument()
    expect(search.clearDecorations).toHaveBeenCalled()
  })

  it('types a dropped file’s quoted path for a server on this computer and refuses for a remote', async () => {
    const { view } = await openConnected()
    const host = view.container.querySelector('.terminal-surface-host')!
    const drop = () => fireEvent.drop(host, { dataTransfer: { types: ['Files'], files: [new File(['x'], 'my notes.txt')] } })
    drop()
    expect(terminalApi.write).toHaveBeenLastCalledWith('profile-a', 4, 'term_abc', `'/Users/me/my notes.txt' `)

    const setError = vi.fn()
    useAppStore.setState({ setError, profiles: [{ ...useAppStore.getState().profiles[0], serverUrl: 'http://127.0.0.1:7850/api/remote/b18c' }] } as never)
    terminalApi.write.mockClear()
    drop()
    expect(terminalApi.write).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith(expect.stringContaining('server on this computer'))
  })

  it('disconnects the shell and disposes the terminal when the tab closes', async () => {
    const view = render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(terminalApi.disconnect).toHaveBeenCalledWith('profile-a', 4, 'term_abc')
    expect(xterm.instances[0].dispose).toHaveBeenCalledOnce()
  })
})
