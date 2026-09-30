import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CanvasCommentThread, Session } from '@shared/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasPane } from './CanvasPane'

const fixture = vi.hoisted(() => ({ state: {
  activeProfileId: 'profile', profileGeneration: 1, drafts: {} as Record<string, string>, health: null as unknown,
  setDraftForSession: (() => {}) as (sessionId: string, text: string) => void,
  sendPromptForSession: (() => Promise.resolve(true)) as (...args: unknown[]) => Promise<boolean>
} }))
vi.mock('../store/app-store', () => ({
  useAppStore: Object.assign((selector: (state: typeof fixture.state) => unknown) => selector(fixture.state), { getState: () => fixture.state }),
  interactiveClientCapabilities: () => ['codex_interactive_v1']
}))
// CodeMirror needs a real layout; a textarea keeps the pane's value/onChange contract observable.
vi.mock('./CodeMirrorEditor', () => ({
  CodeMirrorEditor: ({ value, onChange, ariaLabel, readOnly }: { value: string; onChange: (value: string, lines: number) => void; ariaLabel: string; readOnly: boolean }) =>
    <textarea aria-label={ariaLabel} value={value} readOnly={readOnly} onChange={event => onChange(event.target.value, 1)} />
}))

const session = { id: 'chat-1' } as Session
const target = { sessionId: 'chat-1', name: 'report' }

function renderCanvas() {
  const host = document.body.appendChild(document.createElement('section'))
  const view = render(<CanvasPane session={session} target={target} onClose={() => {}} />, { container: host })
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
    localStorage.setItem('agentsdock:canvas-width', '600')
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
    expect(localStorage.getItem('agentsdock:canvas-width')).toBe('640')
    expect(document.body).not.toHaveClass('canvas-resizing')
  })

  it('resizes from the keyboard and resets to the default width on double-click', () => {
    const { handle, userWidth } = renderCanvas()

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(userWidth()).toBe('536px')
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(localStorage.getItem('agentsdock:canvas-width')).toBe('496')

    fireEvent.doubleClick(handle)
    expect(userWidth()).toBe('')
    expect(localStorage.getItem('agentsdock:canvas-width')).toBeNull()
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


describe('CanvasPane comments and source editing', () => {
  const compiled = { name: 'report', path: '/c/report.canvas.tsx', source: 'old', javascript: 'var a = 1', diagnostics: null, state: {}, revision: 1 }
  const element = { id: 'summary', tag: 'td', text: 'loss 2.41', html: '<td>loss 2.41</td>' }
  const thread = (status: CanvasCommentThread['status'] = 'open'): CanvasCommentThread => ({
    id: 'cmt_1', anchor: { canvas_id: 'summary', tag: 'td', text: 'loss 2.41', html: '<td>loss 2.41</td>' }, status, created_at: 't', updated_at: 't',
    messages: [{ id: 'msg_1', mode: 'ask', body: 'why so high?', revision: 1, created_at: 't', turn: { run_id: null, queued_id: 'q1' }, reply: { status: 'queued' } }]
  })

  beforeEach(() => {
    fixture.state.health = { capabilities: { canvas_v1: { available: true, version: 1, comments: true, source_edit: true } } }
  })
  afterEach(() => {
    fixture.state.health = null
    fixture.state.drafts = {}
  })

  async function renderWith(canvas: Record<string, ReturnType<typeof vi.fn>>) {
    const api: Record<string, ReturnType<typeof vi.fn>> = {
      list: vi.fn().mockResolvedValue({ canvases: [{ name: 'report', path: compiled.path, revision: 1 }] }),
      get: vi.fn().mockResolvedValue(compiled),
      putState: vi.fn(),
      comments: vi.fn().mockResolvedValue({ threads: [] }),
      ...canvas
    }
    vi.stubGlobal('agentsDock', { canvas: api })
    renderCanvas()
    const iframe = (await screen.findByTitle('Canvas report')) as HTMLIFrameElement
    const post = vi.fn()
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: { postMessage: post } })
    const reply = (message: unknown) => {
      const event = new MessageEvent('message', { data: { source: 'agentsdock-canvas', message } })
      Object.defineProperty(event, 'source', { value: iframe.contentWindow })
      window.dispatchEvent(event)
    }
    return { api, post, reply }
  }

  it('asks about a picked element as a stored thread, pins it, and drops the pin once resolved', async () => {
    const created = thread()
    const { api, post, reply } = await renderWith({
      comment: vi.fn().mockResolvedValue({ thread: created }),
      setCommentStatus: vi.fn().mockResolvedValue({ thread: thread('resolved') })
    })

    reply({ kind: 'selection', elements: [element], complete: true })
    fireEvent.change(await screen.findByPlaceholderText('Ask about this element, or describe a change…'), { target: { value: ' why so high? ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))

    await waitFor(() => expect(api.comment).toHaveBeenCalledWith('chat-1', 'report',
      { canvas_id: 'summary', tag: 'td', text: 'loss 2.41', html: '<td>loss 2.41</td>' },
      { mode: 'ask', body: 'why so high?', revision: 1, client_capabilities: ['codex_interactive_v1'] }))
    expect(await screen.findByText('Waiting for the agent…')).toBeInTheDocument()
    expect(post).toHaveBeenLastCalledWith({ source: 'agentsdock-canvas-host', call: 'set-comments', args: [
      [{ id: 'cmt_1', number: 1, canvasId: 'summary', tag: 'td', text: 'loss 2.41', label: 'summary · loss 2.41' }], 'cmt_1'] }, '*')
    // Nothing went to the composer: the thread is the record now.
    expect(fixture.state.drafts).toEqual({})

    reply({ kind: 'comment-anchors', located: [] })
    expect(await screen.findByText('Not in this revision')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    await waitFor(() => expect(post).toHaveBeenLastCalledWith({ source: 'agentsdock-canvas-host', call: 'set-comments', args: [[], 'cmt_1'] }, '*'))
    expect(api.setCommentStatus).toHaveBeenCalledWith('chat-1', 'report', 'cmt_1', 'resolved')
  })

  it('opens the thread a pin was clicked for and focuses its element from the list', async () => {
    const { post, reply } = await renderWith({ comments: vi.fn().mockResolvedValue({ threads: [thread()] }) })
    reply({ kind: 'comment-open', id: 'cmt_1' })
    fireEvent.click(await screen.findByTitle('Show the element'))
    expect(post).toHaveBeenLastCalledWith({ source: 'agentsdock-canvas-host', call: 'focus-comment', args: ['cmt_1'] }, '*')
  })

  it('refreshes threads after a turn and reloads the canvas only when its revision changed', async () => {
    const { api } = await renderWith({})
    const turnEvent = () => window.dispatchEvent(new CustomEvent('agentsdock:canvases-changed', { detail: { sessionId: 'chat-1' } }))
    await waitFor(() => expect(api.comments).toHaveBeenCalledTimes(1))
    turnEvent()
    await waitFor(() => expect(api.comments).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
    expect(api.get).toHaveBeenCalledTimes(1)

    api.list.mockResolvedValue({ canvases: [{ name: 'report', path: compiled.path, revision: 2 }] })
    turnEvent()
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2))
  })

  it('saves edited source against the revision it started from and overwrites a concurrent edit only when confirmed', async () => {
    const putSource = vi.fn()
      .mockRejectedValueOnce(new Error('The canvas changed since it was opened (now revision 5).'))
      .mockResolvedValueOnce({ ...compiled, source: 'mine', revision: 6 })
    const { api } = await renderWith({ putSource })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    fireEvent.change(await screen.findByLabelText('Canvas source'), { target: { value: 'mine' } })
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    api.get.mockResolvedValue({ ...compiled, revision: 5 })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(putSource).toHaveBeenCalledTimes(2))
    expect(putSource.mock.calls[0]).toEqual(['chat-1', 'report', 'mine', 1])
    expect(confirm).toHaveBeenCalledWith('The Canvas changed after you started editing (usually the agent). Replace it with your version?')
    expect(putSource.mock.calls[1]).toEqual(['chat-1', 'report', 'mine', 5])
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('asks the agent to fix a canvas that does not compile', async () => {
    const send = vi.fn().mockResolvedValue(true)
    fixture.state.sendPromptForSession = send
    vi.stubGlobal('agentsDock', { canvas: {
      list: vi.fn().mockResolvedValue({ canvases: [] }),
      get: vi.fn().mockResolvedValue({ ...compiled, javascript: '', diagnostics: 'report.tsx(3,1): error TS1005' }),
      putState: vi.fn(),
      comments: vi.fn().mockResolvedValue({ threads: [] })
    } })
    renderCanvas()
    fireEvent.click(await screen.findByRole('button', { name: 'Fix with agent' }))
    expect(send).toHaveBeenCalledWith('chat-1', expect.stringContaining('report.tsx(3,1): error TS1005'), false, { consumeComposer: false })
  })

  it('falls back to a composer draft that keeps a question a question on servers without threads', async () => {
    fixture.state.health = null
    const drafts: Record<string, string> = {}
    fixture.state.setDraftForSession = (sessionId, text) => { drafts[sessionId] = text }
    const { reply } = await renderWith({})
    reply({ kind: 'selection', elements: [element], complete: true })
    fireEvent.change(await screen.findByPlaceholderText('Ask about this element, or describe a change…'), { target: { value: 'why?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(drafts['chat-1']).toContain('question about the selected elements')
    expect(drafts['chat-1']).toContain('Question (answer it without modifying the canvas): why?')
    expect(drafts['chat-1']).not.toContain('Requested change')
  })
})
