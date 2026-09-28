import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { ChatOutputsSummary, ChatSourceItem } from '@shared/chat-outputs'
import type { AgentFile, Event, SessionSnapshot } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { ChatOutputsPanel } from './ChatOutputsPanel'

const outputs = vi.fn()
const openExternal = vi.fn()

const chart = { id: 'art_1', filename: 'chart.png', content_type: 'image/png', title: 'Sales chart' } as AgentFile
const summary: ChatOutputsSummary = {
  outputs: [
    { kind: 'canvas', label: 'Budget board', path: 'canvases/budget.canvas.tsx' },
    { kind: 'artifact', label: 'Sales chart', eventId: 'art-ev', filename: 'chart.png', contentType: 'image/png', file: chart },
    { kind: 'artifact', label: 'report.pdf', eventId: 'pdf-ev', filename: 'report.pdf', contentType: 'application/pdf', file: { ...chart, id: 'art_2', filename: 'report.pdf', content_type: 'application/pdf', title: undefined } },
    { kind: 'local_preview', url: 'http://localhost:5173/app', host: 'localhost:5173' },
    { kind: 'code_changes', filesChanged: 3, additions: 12, deletions: 4, review: { runId: 'run-2', files: null, additions: 5, deletions: 1, repositoryRoot: '/repo' } }
  ],
  sources: [
    { kind: 'mcp', label: 'Agentsdock Internal Provider 9f3a2c71', count: 2, eventId: 'mcp-ev' },
    { kind: 'web_search', count: 1, eventId: 'search-ev' },
    { kind: 'web_fetch', count: 3, eventId: 'fetch-ev' },
    { kind: 'skill', label: 'review-pr', eventId: 'skill-ev' },
    { kind: 'chat_reference', label: 'Planning chat', eventId: 'ref-ev' },
    { kind: 'attached_file', label: 'spec.md', eventId: 'file-ev' }
  ]
}

const snapshot = (events: Event[]): SessionSnapshot => ({
  session: { id: 'chat', title: 'Chat', backend: 'codex' },
  events, queuedTurns: [], files: [], hasMoreEvents: false, filesTotal: 0, cachedAt: 0
})

async function renderPanel(onClose = vi.fn(), value: ChatOutputsSummary = summary) {
  outputs.mockResolvedValue(value)
  const view = render(<ChatOutputsPanel sessionId="chat" onClose={onClose} />)
  await screen.findByRole('heading', { name: 'Outputs' })
  return { view, onClose }
}

beforeEach(() => {
  outputs.mockReset()
  openExternal.mockReset()
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: { chat: { outputs }, native: { openExternal } } as unknown as AgentsDockAPI
  })
  useAppStore.setState({ snapshots: { chat: snapshot([]) } })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ChatOutputsPanel', () => {
  it('renders both sections with the localized secondary labels', async () => {
    await renderPanel()

    expect(outputs).toHaveBeenCalledWith('chat')
    const rows = screen.getAllByRole('button').filter(button => button.classList.contains('chat-outputs-row'))
    expect(rows.map(row => row.textContent)).toEqual([
      'Budget boardCanvas',
      'Sales chartGenerated image',
      'report.pdfPDF file',
      'Local previewlocalhost:5173',
      'Edited 3 files+12 −4',
      'Agentsdock Internal Provider 9f3a2c712 uses',
      'Web searchSearched once',
      'Web pagesOpened 3 pages',
      'review-prSkill',
      'Planning chatReferenced chat',
      'spec.mdAttached to this chat'
    ])
  })

  it('dispatches the right window events and IPC for each output kind', async () => {
    await renderPanel()
    const dispatched: CustomEvent[] = []
    const record = (event: globalThis.Event) => dispatched.push(event as CustomEvent)
    for (const name of ['agentsdock:open-canvas', 'agentsdock:open-agent-file', 'agentsdock:find-event', 'agentsdock:review-diff']) window.addEventListener(name, record)
    const user = userEvent.setup()

    // A row's accessible name is its label followed by the secondary text.
    await user.click(screen.getByRole('button', { name: /^Budget board/ }))
    await user.click(screen.getByRole('button', { name: /^Sales chart/ }))
    await user.click(screen.getByRole('button', { name: /^Local preview/ }))
    await user.click(screen.getByRole('button', { name: /^Edited 3 files/ }))
    await user.click(screen.getByRole('button', { name: /^Planning chat/ }))

    expect(dispatched.map(event => [event.type, event.detail])).toEqual([
      ['agentsdock:open-canvas', { sessionId: 'chat', path: 'canvases/budget.canvas.tsx' }],
      // Generated files open in the editor like the timeline card does; only sources jump to their event.
      ['agentsdock:open-agent-file', { sessionId: 'chat', file: chart }],
      ['agentsdock:review-diff', { sessionId: 'chat', runId: 'run-2', files: null, additions: 5, deletions: 1, repositoryRoot: '/repo' }],
      ['agentsdock:find-event', { sessionId: 'chat', eventId: 'ref-ev' }]
    ])
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('http://localhost:5173/app')
    for (const name of ['agentsdock:open-canvas', 'agentsdock:open-agent-file', 'agentsdock:find-event', 'agentsdock:review-diff']) window.removeEventListener(name, record)
  })

  it('collapses sources to six rows behind a view-all toggle', async () => {
    const sources: ChatSourceItem[] = Array.from({ length: 8 }, (_, index) => ({ kind: 'skill', label: `skill-${index}`, eventId: `s${index}` }))
    await renderPanel(vi.fn(), { outputs: [], sources })
    const user = userEvent.setup()

    expect(screen.getAllByRole('button', { name: /^skill-/ })).toHaveLength(6)
    await user.click(screen.getByRole('button', { name: 'View all (8)' }))
    expect(screen.getAllByRole('button', { name: /^skill-/ })).toHaveLength(8)
    await user.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getAllByRole('button', { name: /^skill-/ })).toHaveLength(6)
  })

  it('shows empty states for a chat without outputs or sources', async () => {
    await renderPanel(vi.fn(), { outputs: [], sources: [] })

    expect(screen.getByText('No outputs yet')).toBeInTheDocument()
    expect(screen.getByText('No sources yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /View all/ })).not.toBeInTheDocument()
  })

  it('closes on Escape and on pointer-down outside, but not inside or on the header toggle', async () => {
    const toggle = document.createElement('button')
    toggle.setAttribute('data-chat-outputs-toggle', '')
    document.body.append(toggle)
    const { onClose } = await renderPanel()

    fireEvent.pointerDown(screen.getByRole('heading', { name: 'Sources' }))
    fireEvent.pointerDown(toggle)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    toggle.remove()
  })

  it('refetches once, about a second after new events land for the session', async () => {
    vi.useFakeTimers()
    outputs.mockResolvedValue(summary)
    render(<ChatOutputsPanel sessionId="chat" onClose={vi.fn()} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(outputs).toHaveBeenCalledTimes(1)

    const event = (seq: number): Event => ({ id: `e${seq}`, seq, session_id: 'chat', type: 'assistant_text', ts: 't', text: 'x' })
    act(() => useAppStore.setState({ snapshots: { chat: snapshot([event(1)]) } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    act(() => useAppStore.setState({ snapshots: { chat: snapshot([event(1), event(2)]) } }))
    await act(async () => { await vi.advanceTimersByTimeAsync(600) })
    expect(outputs).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(400) })
    expect(outputs).toHaveBeenCalledTimes(2)
  })
})
