import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Surface } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { TerminalSurface } from './TerminalSurface'

const ghostty = vi.hoisted(() => ({
  instances: [] as Array<Record<string, any>>,
  init: vi.fn(async () => undefined)
}))

vi.mock('ghostty-web', () => ({
  init: ghostty.init,
  FitAddon: class { fit = vi.fn(); activate() {} dispose() {} },
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown>
    write = vi.fn()
    focus = vi.fn()
    clear = vi.fn()
    reset = vi.fn()
    selectAll = vi.fn()
    hasSelection = vi.fn(() => false)
    getSelection = vi.fn(() => '')
    dispose = vi.fn()
    loadAddon = vi.fn()
    open = vi.fn()
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null
    dataListener: ((data: string) => void) | null = null
    resizeListener: ((size: { cols: number; rows: number }) => void) | null = null
    constructor(options: Record<string, unknown>) {
      this.options = options
      ghostty.instances.push(this)
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.keyHandler = handler }
    input(data: string, wasUserInput = false) { if (wasUserInput) this.dataListener?.(data) }
    onData(listener: (data: string) => void) { this.dataListener = listener; return { dispose: vi.fn() } }
    onResize(listener: (size: { cols: number; rows: number }) => void) { this.resizeListener = listener; return { dispose: vi.fn() } }
  }
}))

const surface: Surface = { id: 'term_abc', kind: 'terminal', name: null, folder: 'General', cwd: '/work/app', url: null, page_title: null, created_at: '', updated_at: '' }
type Listener = (payload: any) => void
let listeners: Record<string, Listener[]>
let terminalApi: { connect: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
let writeClipboard: ReturnType<typeof vi.fn>

beforeEach(() => {
  ghostty.instances.length = 0
  listeners = {}
  terminalApi = {
    connect: vi.fn().mockResolvedValue(undefined),
    write: vi.fn(),
    resize: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined)
  }
  writeClipboard = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: {
      terminal: terminalApi,
      native: { writeClipboard },
      events: { on: (name: string, listener: Listener) => { (listeners[name] ??= []).push(listener); return () => { listeners[name] = listeners[name].filter(item => item !== listener) } } }
    } as unknown as AgentsDockAPI
  })
  useAppStore.setState({ activeProfileId: 'profile-a', profileGeneration: 4 })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const emit = (name: string, payload: Record<string, unknown>) => act(() => { for (const listener of listeners[name] ?? []) listener({ profileId: 'profile-a', profileGeneration: 4, sessionId: surface.id, ...payload }) })

describe('TerminalSurface', () => {
  it('opens one Ghostty terminal, connects a shell in the tab directory, and relays bytes both ways', async () => {
    render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledWith('profile-a', 4, 'term_abc', { cwd: '/work/app', columns: 80, rows: 24 }))
    expect(ghostty.init).toHaveBeenCalledOnce()
    const [terminal] = ghostty.instances
    expect(terminal.open).toHaveBeenCalledOnce()
    expect(screen.getByRole('status')).toHaveTextContent('Starting shell…')

    emit('terminal:state', { state: 'connected', name: 'zsh' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(terminal.focus).toHaveBeenCalled()
    // The server replays the shell's scrollback after every attach, so the screen starts clean.
    expect(terminal.reset).toHaveBeenCalledOnce()

    emit('terminal:data', { data: 'héllo ' })
    emit('terminal:data', { data: '中文\r\n' })
    await waitFor(() => expect(terminal.write).toHaveBeenCalledWith('héllo 中文\r\n'))

    act(() => terminal.dataListener?.('ls\r'))
    expect(terminalApi.write).toHaveBeenCalledWith('profile-a', 4, 'term_abc', 'ls\r')
    act(() => terminal.resizeListener?.({ cols: 100, rows: 30 }))
    expect(terminalApi.resize).toHaveBeenCalledWith('profile-a', 4, 'term_abc', 100, 30)

    // Bytes for another tab or profile never reach this terminal.
    emit('terminal:data', { data: 'other', sessionId: 'term_other' })
    emit('terminal:data', { data: 'stale', profileGeneration: 3 })
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
    expect(terminal.write).toHaveBeenCalledTimes(1)
  })

  it('answers a Primary Device Attributes query for the shell, once per query', async () => {
    render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    emit('terminal:state', { state: 'connected', name: 'fish' })

    // fish 4's startup probe: kitty keyboard, XTVERSION, OSC 11, XTGETTCAP, then DA1 as the sentinel it waits for.
    emit('terminal:data', { data: '\x1b[?u\x1b[>0q\x1b]11;?\x1b\\\x1b[?1049h\x1bP+q696e646e\x1b\\\x1b[?1049l\x1b[0c' })
    await waitFor(() => expect(ghostty.instances[0].write).toHaveBeenCalledTimes(1))
    expect(terminalApi.write).toHaveBeenCalledTimes(1)
    expect(terminalApi.write).toHaveBeenCalledWith('profile-a', 4, 'term_abc', '\x1b[?62;22c')

    emit('terminal:data', { data: 'prompt> \x1b[c' })
    emit('terminal:data', { data: 'no query here' })
    await waitFor(() => expect(ghostty.instances[0].write).toHaveBeenCalledTimes(2))
    expect(terminalApi.write).toHaveBeenCalledTimes(2)
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
    expect(ghostty.instances).toHaveLength(1)
    expect(ghostty.instances[0].dispose).not.toHaveBeenCalled()
    emit('terminal:state', { state: 'connected' })
    expect(ghostty.instances[0].reset).toHaveBeenCalledTimes(2)
  })

  it('shows the server error with a retry when the connection fails', async () => {
    render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    emit('terminal:state', { state: 'error', error: 'This AgentsServer is too old for standalone terminals. Update it, then open the terminal again.' })
    expect(screen.getByRole('status')).toHaveTextContent('too old for standalone terminals')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('copies the selection on Command-C, lets Command-V reach the native paste, clears on Command-K, and leaves Command-R to the rename menu', async () => {
    render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(ghostty.instances).toHaveLength(1))
    const [terminal] = ghostty.instances
    const key = (patch: Partial<KeyboardEvent>) => ({ type: 'keydown', metaKey: true, key: 'c', ...patch }) as KeyboardEvent

    expect(terminal.keyHandler(key({}))).toBe(false)
    expect(writeClipboard).not.toHaveBeenCalled()
    terminal.hasSelection.mockReturnValue(true)
    terminal.getSelection.mockReturnValue('selected text')
    expect(terminal.keyHandler(key({}))).toBe(false)
    expect(writeClipboard).toHaveBeenCalledWith('selected text')
    expect(terminal.keyHandler(key({ key: 'v' }))).toBe(true)
    expect(terminal.keyHandler(key({ key: 'k' }))).toBe(false)
    expect(terminal.clear).toHaveBeenCalledOnce()
    // ⌘R is swallowed from the shell and runs the app's rename command for this tab.
    const renameSurface = vi.fn()
    window.addEventListener('agentsdock:rename-surface', renameSurface)
    useAppStore.setState({ surfaces: [surface], selectedSurfaceId: surface.id })
    expect(terminal.keyHandler(key({ key: 'r' }))).toBe(true)
    expect(terminal.keyHandler(key({ key: 'r', metaKey: false }))).toBe(true)
    useAppStore.setState({ surfaces: [], selectedSurfaceId: null })
    window.removeEventListener('agentsdock:rename-surface', renameSurface)
    expect(renameSurface).toHaveBeenCalledOnce()
    expect((renameSurface.mock.calls[0][0] as CustomEvent).detail).toEqual({ surfaceId: 'term_abc' })
    expect(terminal.keyHandler(key({ key: 'c', metaKey: false }))).toBe(true)
  })

  it('sends text inserted without an IME composition to the shell, and leaves composed text to ghostty-web', async () => {
    const { container } = render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    const host = container.querySelector('.terminal-surface-host')!

    act(() => { host.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '🚀 héllo', bubbles: true, cancelable: true })) })
    expect(terminalApi.write).toHaveBeenCalledWith('profile-a', 4, 'term_abc', '🚀 héllo')

    act(() => { host.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', data: '中', bubbles: true, cancelable: true })) })
    act(() => { host.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: '中文', isComposing: true, bubbles: true, cancelable: true })) })
    expect(terminalApi.write).toHaveBeenCalledTimes(1)
  })

  it('disconnects the shell and disposes the terminal when the tab closes', async () => {
    const view = render(<TerminalSurface surface={surface} active />)
    await waitFor(() => expect(terminalApi.connect).toHaveBeenCalledTimes(1))
    view.unmount()
    expect(terminalApi.disconnect).toHaveBeenCalledWith('profile-a', 4, 'term_abc')
    expect(ghostty.instances[0].dispose).toHaveBeenCalledOnce()
  })
})
