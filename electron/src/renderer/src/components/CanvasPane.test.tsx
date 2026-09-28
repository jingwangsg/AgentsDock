import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Session } from '@shared/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasPane, canvasWidthStorageKey } from './CanvasPane'

const fixture = vi.hoisted(() => ({ state: { activeProfileId: 'profile', profileGeneration: 1, drafts: {} } }))
vi.mock('../store/app-store', () => ({ useAppStore: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state), { getState: () => fixture.state }) }))

const session = { id: 'chat-1' } as Session
const target = { sessionId: 'chat-1', name: 'report' }

function renderCanvas(workspaceKey = 'server:alpha') {
  const host = document.body.appendChild(document.createElement('section'))
  const view = render(<CanvasPane workspaceKey={workspaceKey} session={session} target={target} onClose={() => {}} />, { container: host })
  const pane = screen.getByRole('region', { name: 'Canvas' })
  const userWidth = () => host.style.getPropertyValue('--canvas-pane-user-width')
  // jsdom has no layout: apply CanvasPane.css's clamp for a 1000px conversation pane (default 52% = 520px).
  vi.spyOn(pane, 'getBoundingClientRect').mockImplementation(() =>
    ({ width: Math.min(Math.max(Number.parseFloat(userWidth()) || 520, 280), 1000 - 360) }) as DOMRect)
  return { ...view, userWidth, handle: screen.getByRole('separator', { name: 'Resize Canvas' }) }
}

beforeEach(() => {
  // jsdom lacks pointer capture; Chromium provides it.
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  const pending = () => new Promise(() => {})
  vi.stubGlobal('agentsDock', { canvas: { list: vi.fn(pending), get: vi.fn(pending), putState: vi.fn() } })
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('CanvasPane width', () => {
  it('restores the saved width and drops it, with any drag state, on close', () => {
    localStorage.setItem(canvasWidthStorageKey('server:alpha'), '600')
    const { handle, userWidth, unmount } = renderCanvas()
    expect(userWidth()).toBe('600px')

    fireEvent.pointerDown(handle, { pointerId: 3, clientX: 900 })
    expect(document.body).toHaveClass('canvas-resizing')
    unmount()

    expect(userWidth()).toBe('')
    expect(document.body).not.toHaveClass('canvas-resizing')
  })

  it('widens when the left edge is dragged left and stores the width that rendered after the clamp', () => {
    const { handle, userWidth } = renderCanvas()

    fireEvent.pointerDown(handle, { pointerId: 3, clientX: 900 })
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 800 })
    expect(userWidth()).toBe('620px')
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 500 })
    expect(userWidth()).toBe('920px')

    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 500 })
    expect(userWidth()).toBe('640px')
    expect(localStorage.getItem(canvasWidthStorageKey('server:alpha'))).toBe('640')
    expect(document.body).not.toHaveClass('canvas-resizing')
  })

  it('resizes from the keyboard and resets to the default width on double-click', () => {
    const { handle, userWidth } = renderCanvas()

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(userWidth()).toBe('536px')
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(localStorage.getItem(canvasWidthStorageKey('server:alpha'))).toBe('496')

    fireEvent.doubleClick(handle)
    expect(userWidth()).toBe('')
    expect(localStorage.getItem(canvasWidthStorageKey('server:alpha'))).toBeNull()
  })
})

describe('CanvasPane view toggle', () => {
  it('switches between Preview and Source with labelled buttons that stay visible in both views', async () => {
    const record = { name: 'report', path: 'canvases/report.tsx', source: 'export const a = 1', javascript: '', diagnostics: null, state: {} }
    vi.stubGlobal('agentsDock', { canvas: {
      list: vi.fn().mockResolvedValue({ canvases: [{ name: 'report', path: record.path }] }),
      get: vi.fn().mockResolvedValue(record),
      putState: vi.fn()
    } })
    renderCanvas()
    await screen.findByText('Canvas did not compile', { exact: false }).catch(() => null)

    const source = screen.getByRole('button', { name: 'Source' })
    const preview = screen.getByRole('button', { name: 'Preview' })
    expect(preview).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(source)
    expect(await screen.findByText('export const a = 1')).toBeInTheDocument()
    expect(source).toHaveAttribute('aria-pressed', 'true')
    // The way back is the same labelled control, not a mode-dependent icon.
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    expect(screen.queryByText('export const a = 1')).toBeNull()
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('CanvasPane find', () => {
  const compiled = { name: 'report', path: 'canvases/report.tsx', source: 'source', javascript: 'var a = 1', diagnostics: null, state: {}, revision: 1 }

  async function renderCompiled() {
    vi.stubGlobal('agentsDock', { canvas: {
      list: vi.fn().mockResolvedValue({ canvases: [{ name: 'report', path: compiled.path }] }),
      get: vi.fn().mockResolvedValue(compiled),
      putState: vi.fn()
    } })
    renderCanvas()
    const iframe = (await screen.findByTitle('Canvas report')) as HTMLIFrameElement
    const post = vi.fn()
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: { postMessage: post } })
    // The page reports back over the same channel the parent listens on; source must match the frame.
    const reply = (message: unknown) => {
      const event = new MessageEvent('message', { data: { source: 'agentsdock-canvas', message } })
      Object.defineProperty(event, 'source', { value: iframe.contentWindow })
      window.dispatchEvent(event)
    }
    return { iframe, post, reply }
  }

  it('opens from the header, posts the query, renders the count, steps and clears on Esc', async () => {
    const { post, reply } = await renderCompiled()

    fireEvent.click(screen.getByRole('button', { name: 'Find in Canvas' }))
    const input = screen.getByPlaceholderText('Search text…')
    fireEvent.change(input, { target: { value: 'hello' } })
    expect(post).toHaveBeenCalledWith(
      { source: 'agentsdock-canvas-host', call: 'find', args: ['hello', { forward: true, matchCase: false, findNext: false }] }, '*')

    reply({ type: 'find-result', total: 12, active: 3 })
    expect(await screen.findByText('3/12')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(post).toHaveBeenLastCalledWith(
      { source: 'agentsdock-canvas-host', call: 'find', args: ['hello', { forward: true, matchCase: false, findNext: true }] }, '*')
    fireEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(post).toHaveBeenLastCalledWith(
      { source: 'agentsdock-canvas-host', call: 'find', args: ['hello', { forward: false, matchCase: false, findNext: true }] }, '*')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(post).toHaveBeenLastCalledWith({ source: 'agentsdock-canvas-host', call: 'clear-find', args: [] }, '*')
    expect(screen.queryByPlaceholderText('Search text…')).toBeNull()
  })

  it('opens with Cmd-F and steps backward with Shift-Enter', async () => {
    const { post, reply } = await renderCompiled()

    fireEvent.keyDown(screen.getByRole('region', { name: 'Canvas' }), { key: 'f', metaKey: true })
    const input = screen.getByPlaceholderText('Search text…')
    fireEvent.change(input, { target: { value: 'x' } })
    reply({ type: 'find-result', total: 2, active: 1 })
    expect(await screen.findByText('1/2')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(post).toHaveBeenLastCalledWith(
      { source: 'agentsdock-canvas-host', call: 'find', args: ['x', { forward: false, matchCase: false, findNext: true }] }, '*')
  })
})
