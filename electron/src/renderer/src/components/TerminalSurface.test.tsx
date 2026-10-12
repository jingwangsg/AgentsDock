import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Surface } from '@shared/types'
import { updateTerminalSettings } from '../lib/terminal-settings'
import { useTerminalStatus } from '../lib/terminal-status'
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
    csi: Array<[string, (params: number[]) => boolean]> = []
    dcs: Array<[string, (data: string, params: number[]) => boolean]> = []
    listeners: Record<string, (value?: any) => void> = {}
    markers: Array<{ line: number; isDisposed: boolean; dispose: () => void }> = []
    textarea = document.createElement('textarea')
    parser = {
      registerOscHandler: (ident: number, handler: (data: string) => boolean) => { this.osc.set(ident, handler); return { dispose() {} } },
      registerCsiHandler: (id: { prefix?: string; intermediates?: string; final: string }, handler: (params: number[]) => boolean) => { this.csi.push([`${id.prefix ?? ''}${id.intermediates ?? ''}${id.final}`, handler]); return { dispose() {} } },
      registerDcsHandler: (id: { intermediates?: string; final: string }, handler: (data: string, params: number[]) => boolean) => { this.dcs.push([`${id.intermediates ?? ''}${id.final}`, handler]); return { dispose() {} } }
    }
    // The newest handler for a sequence answers first; true means it consumed the sequence.
    consumesCsi(id: string, params: number[] = []) { return this.csi.filter(([key]) => key === id).some(([, handler]) => handler(params)) }
    consumesDcs(id: string) { return this.dcs.filter(([key]) => key === id).some(([, handler]) => handler('', [])) }
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
    registerMarker() {
      const marker = { line: this.buffer.active.baseY + this.buffer.active.cursorY, isDisposed: false, dispose() { marker.isDisposed = true } }
      this.markers.push(marker)
      return marker
    }
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
  emit('terminal:state', { state: 'connected', name: 'zsh', replayBytes: 19 })
  const terminal = xterm.instances[0]
  emit('terminal:data', { data: 'replayed scrollback', replay: true })
  act(() => terminal.finishWrites())
  return { view, terminal }
}
const nextFrame = () => act(async () => { await new Promise(resolve => window.requestAnimationFrame(resolve)) })

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

    emit('terminal:state', { state: 'connected', name: 'zsh', replayBytes: 0 })
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
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
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
    const replay = '\x1b]52;c;b2xk\x07\x07\x1b]9;old\x07'
    emit('terminal:state', { state: 'connected', name: 'zsh', replayBytes: replay.length })
    emit('terminal:data', { data: replay, replay: true })
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

  it('posts OSC 777 notifications at most once a second, and marks a bell only while the tab is out of sight', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
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
    act(() => terminal.osc.get(9)('again too soon'))
    expect(native.notify).toHaveBeenCalledOnce()
    now.mockReturnValue(11_500)
    act(() => terminal.osc.get(9)('tests passed'))
    expect(native.notify).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'vim notes.md', body: 'tests passed' }))

    // A bell while the window is in the background marks the tab; returning to the window clears it.
    function BellMark() { return <output aria-label="bell">{String(useTerminalStatus(surface.id).bell)}</output> }
    render(<BellMark />)
    act(() => terminal.listeners.bell())
    expect(screen.getByLabelText('bell')).toHaveTextContent('true')
    hasFocus.mockReturnValue(true)
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(screen.getByLabelText('bell')).toHaveTextContent('false')
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
    // While the field is edited the shell's new title does not replace what the user is typing.
    act(() => { title.focus() })
    act(() => terminal.listeners.title('top'))
    expect(title).toHaveValue('htop')
    fireEvent.change(title, { target: { value: 'build box' } })
    act(() => { title.blur() })
    expect(updateSurface).toHaveBeenCalledExactlyOnceWith('term_abc', { name: 'build box' })
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

    // Line-editing chords are typed to the shell (the byte table is in terminal-input.test.ts).
    keydown({ key: 'ArrowLeft', metaKey: true })
    expect(terminalApi.write).toHaveBeenLastCalledWith('profile-a', 4, 'term_abc', '\x01')

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

    // The prompt at 102 is already on the bottom screen, so the first jump goes above it.
    keydown({ key: 'ArrowUp', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(40)
    keydown({ key: 'ArrowUp', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(3)
    keydown({ key: 'ArrowUp', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenCalledTimes(2)
    keydown({ key: 'ArrowDown', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(40)
    // A manual scroll in between continues from the view's top line.
    buffer.viewportY = 20
    keydown({ key: 'ArrowDown', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(40)
    keydown({ key: 'ArrowDown', metaKey: true })
    expect(terminal.scrollToLine).toHaveBeenLastCalledWith(102)
    expect(buffer.viewportY).toBe(100)
    // Below the last prompt that is still in the scrollback, ⌘↓ returns to the bottom.
    terminal.markers[2].isDisposed = true
    buffer.viewportY = 60
    keydown({ key: 'ArrowDown', metaKey: true })
    expect(terminal.scrollToBottom).toHaveBeenCalledOnce()
    expect(buffer.viewportY).toBe(100)
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

  it('copies a mouse selection when the setting is on, but not a Find match or Select All', async () => {
    const { view, terminal } = await openConnected()
    const host = view.container.querySelector('.terminal-surface-host')!
    terminal.hasSelection.mockReturnValue(true)
    terminal.getSelection.mockReturnValue('word')
    const mouseSelect = () => {
      fireEvent.mouseDown(host, { button: 0 })
      act(() => terminal.listeners.selection())
      fireEvent.mouseUp(window)
    }
    mouseSelect()
    expect(native.writeClipboard).not.toHaveBeenCalled()

    act(() => updateTerminalSettings({ copyOnSelect: true }))
    mouseSelect()
    expect(native.writeClipboard).toHaveBeenCalledExactlyOnceWith('word')
    await act(async () => { await new Promise(resolve => setTimeout(resolve)) })
    // Selections made by Find, ⌘A or a right click are not copied.
    act(() => terminal.listeners.selection())
    fireEvent.mouseDown(host, { button: 2 })
    act(() => terminal.listeners.selection())
    expect(native.writeClipboard).toHaveBeenCalledOnce()
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

    search.clearDecorations.mockClear()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Use regular expression' }))
    expect(search.findNext).toHaveBeenLastCalledWith('err', expect.objectContaining({ regex: true }))
    // The same query with new options must search again, not keep the addon's cached highlights.
    expect(search.clearDecorations.mock.invocationCallOrder[0]).toBeLessThan(search.findNext.mock.invocationCallOrder.at(-1)!)
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
    const drop = (name: string) => fireEvent.drop(host, { dataTransfer: { types: ['Files'], files: [new File(['x'], name)] } })
    drop('my notes.txt')
    expect(terminalApi.write).toHaveBeenLastCalledWith('profile-a', 4, 'term_abc', `'/Users/me/my notes.txt' `)

    const setError = vi.fn()
    useAppStore.setState({ setError } as never)
    terminalApi.write.mockClear()
    drop('bad\nname')
    expect(setError).toHaveBeenLastCalledWith(expect.stringContaining('control character'))

    useAppStore.setState({ profiles: [{ ...useAppStore.getState().profiles[0], serverUrl: 'http://127.0.0.1:7850/api/remote/b18c' }] })
    drop('my notes.txt')
    expect(terminalApi.write).not.toHaveBeenCalled()
    expect(setError).toHaveBeenLastCalledWith(expect.stringContaining('server runs on this computer'))
  })

  it('swallows answered queries in a replay, answers the ones that end it, and answers live ones', async () => {
    const { terminal } = await openConnected()
    const replay = 'old \x1b[c answered\r\n\x1b[0c'
    emit('terminal:state', { state: 'connected', name: 'zsh', replayBytes: replay.length })
    emit('terminal:data', { data: replay, replay: true })
    // The query that ends the replay is parsed apart from the rest: the program may still wait for it.
    expect(terminal.writes.slice(-2)).toEqual(['old \x1b[c answered\r\n', '\x1b[0c'])
    for (const id of ['n', '?n', 'c', '>c', '=c', '>q', '$p', '?$p', '?u', '?S']) expect(terminal.consumesCsi(id), id).toBe(true)
    expect(terminal.consumesCsi('t', [14])).toBe(true)
    expect(terminal.consumesCsi('t', [22])).toBe(false)
    expect(terminal.consumesDcs('$q')).toBe(true)
    expect(terminal.consumesDcs('+q')).toBe(true)
    for (const ident of [4, 10, 11, 12, 17, 19, 52]) expect(terminal.osc.get(ident)(ident === 4 ? '1;?' : ident === 52 ? 'c;?' : '?'), String(ident)).toBe(true)
    expect(terminal.osc.get(52)('c;aGk=')).toBe(false)

    // RIS, then the answered part: the trailing query is answered, side effects stay suppressed.
    act(() => { terminal.pendingWriteCallbacks.splice(0, 2).forEach((callback: () => void) => callback()) })
    expect(terminal.consumesCsi('c')).toBe(false)
    addon('clipboard').provider.writeText('c', 'replayed copy')
    expect(native.writeClipboard).not.toHaveBeenCalled()
    act(() => terminal.finishWrites())
    expect(terminal.consumesDcs('+q')).toBe(false)
    expect(terminal.osc.get(11)('?')).toBe(false)
  })

  it('takes the replay from the replay flag alone: none for a new shell, and live data right after one', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    const [terminal] = xterm.instances
    // A new shell: its first output is live.
    emit('terminal:state', { state: 'connected', replayBytes: 0 })
    act(() => terminal.finishWrites())
    emit('terminal:data', { data: 'prompt' })
    expect(terminal.consumesCsi('c')).toBe(false)

    // A replay that ends inside a character ('h' and the first byte of 'é'): the main process completes it in
    // the next, live, data.
    emit('terminal:state', { state: 'connected', replayBytes: 2 })
    emit('terminal:data', { data: 'h', replay: true })
    emit('terminal:data', { data: 'éllo \x1b[6n' })
    act(() => terminal.finishWrites())
    expect(terminal.consumesCsi('n')).toBe(false)
    act(() => terminal.osc.get(9)('live notification'))
    expect(native.notify).toHaveBeenCalledOnce()
  })

  it('takes the pty’s size when the user shows the tab or it reconnects in front of the user, not otherwise', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const view = render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    await nextFrame()
    terminalApi.resize.mockClear()
    // Shown, but the window is in the background (the user is on the phone): a reconnect leaves the size alone.
    emit('terminal:state', { state: 'connected', replayBytes: 0 })
    expect(terminalApi.resize).not.toHaveBeenCalled()
    hasFocus.mockReturnValue(true)
    emit('terminal:state', { state: 'connected', replayBytes: 0 })
    expect(terminalApi.resize).toHaveBeenCalledWith('profile-a', 4, 'term_abc', 80, 24)

    // A profile change reconnects every tab; it is not the user showing this one.
    terminalApi.resize.mockClear()
    act(() => { useAppStore.setState({ profileGeneration: 5 }) })
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(2))
    act(() => { useAppStore.setState({ profileGeneration: 4 }) })
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(3))
    await nextFrame()
    expect(terminalApi.resize).not.toHaveBeenCalled()

    // Hidden: a reconnect leaves the size alone, focused window or not.
    view.rerender(<TerminalSurface surface={surface} active={false} />)
    await nextFrame()
    emit('terminal:state', { state: 'connected', replayBytes: 0 })
    expect(terminalApi.resize).not.toHaveBeenCalled()

    // Shown again by the user: this device takes the size, even with it unchanged.
    view.rerender(<TerminalSurface surface={surface} active />)
    await nextFrame()
    expect(terminalApi.resize).toHaveBeenCalledWith('profile-a', 4, 'term_abc', 80, 24)
  })

  it('rebuilds the screen on a resync without taking the size or the focus', async () => {
    const { terminal } = await openConnected()
    await nextFrame()
    terminalApi.resize.mockClear()
    terminal.focus.mockClear()
    emit('terminal:state', { state: 'connected', replayBytes: 5, resync: true })
    emit('terminal:data', { data: 'again', replay: true })
    expect(terminal.writes.slice(-2)).toEqual(['\x1bc', 'again'])
    expect(terminalApi.resize).not.toHaveBeenCalled()
    expect(terminal.focus).not.toHaveBeenCalled()
  })

  it('suppresses replayed side effects from a resync’s announcement on, before its replay arrives', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const { terminal } = await openConnected()
    emit('terminal:state', { state: 'connected', replayBytes: 5, resync: true })
    // Output parsed between the announcement and the replay: the end of an earlier replay.
    act(() => terminal.osc.get(9)('replayed'))
    expect(native.notify).not.toHaveBeenCalled()
    emit('terminal:data', { data: 'again', replay: true })
    act(() => terminal.finishWrites())
    act(() => terminal.osc.get(9)('live'))
    expect(native.notify).toHaveBeenCalledOnce()
  })

  it('keeps a newer replay’s side effects suppressed when an older replay finishes during it', async () => {
    const { terminal } = await openConnected()
    emit('terminal:state', { state: 'connected' })
    emit('terminal:data', { data: 'first replay', replay: true })
    emit('terminal:state', { state: 'connected' })
    emit('terminal:data', { data: 'second replay', replay: true })
    // The first RIS and replay finish while the second replay is still queued.
    act(() => { terminal.pendingWriteCallbacks.splice(0, 3).forEach((callback: () => void) => callback()) })
    expect(terminal.consumesCsi('c')).toBe(true)
    act(() => terminal.finishWrites())
    expect(terminal.consumesCsi('c')).toBe(false)
  })

  it('drops the prompt marks of the old screen when an attach resets it', async () => {
    const { terminal } = await openConnected()
    terminal.osc.get(133)('A')
    const [marker] = terminal.markers
    emit('terminal:state', { state: 'connected' })
    expect(marker.isDisposed).toBe(false)
    act(() => terminal.finishWrites())
    expect(marker.isDisposed).toBe(true)
    terminal.buffer.active.viewportY = 10
    keydown({ key: 'ArrowUp', metaKey: true })
    expect(terminal.scrollToLine).not.toHaveBeenCalled()
  })

  it('refocuses an open find bar on a second Find, and runs Control-Shift chords elsewhere', async () => {
    const { terminal } = await openConnected()
    const find = () => act(() => { window.dispatchEvent(new CustomEvent('agentsdock:find-active-surface', { cancelable: true })) })
    find()
    const input = await screen.findByRole('textbox', { name: 'Find' })
    act(() => { terminal.textarea.focus() })
    find()
    expect(input).toHaveFocus()
    await userEvent.setup().keyboard('{Escape}')

    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64')
    cleanup()
    xterm.instances.length = 0
    render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(xterm.instances).toHaveLength(1))
    const linux = xterm.instances[0]
    const press = (patch: Partial<KeyboardEvent>) => linux.keyHandler({ type: 'keydown', key: 'f', code: 'KeyF', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, preventDefault: vi.fn(), ...patch } as unknown as KeyboardEvent)
    // Control-F stays with the shell; Control-Shift-F finds and Control-Shift-W closes the tab.
    expect(press({})).toBe(true)
    expect(press({ shiftKey: true, key: 'F' })).toBe(false)
    expect(await screen.findByRole('textbox', { name: 'Find' })).toBeInTheDocument()
    const closeSurface = vi.fn()
    window.addEventListener('agentsdock:close-surface', closeSurface)
    expect(press({ shiftKey: true, key: 'W', code: 'KeyW' })).toBe(false)
    window.removeEventListener('agentsdock:close-surface', closeSurface)
    expect(closeSurface).toHaveBeenCalledOnce()
  })

  it('disconnects the shell and disposes the terminal when the tab closes', async () => {
    const view = render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(terminalApi.disconnect).toHaveBeenCalledWith('profile-a', 4, 'term_abc')
    expect(xterm.instances[0].dispose).toHaveBeenCalledOnce()
  })
})
