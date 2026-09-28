import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { MarkdownContent } from './MarkdownContent'
import SafeHtmlMarkdownContent from './SafeHtmlMarkdownContent'

// jsdom has no SVG layout, so the renderer is a stub; these tests pin the
// fence → container contract around it.
const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: mermaid }))

const DEFINITION = 'flowchart LR\n  a --> b'
const FENCE = `\`\`\`mermaid\n${DEFINITION}\n\`\`\``

describe('MarkdownContent mermaid fences', () => {
  const writeClipboard = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    mermaid.initialize.mockReset()
    mermaid.render.mockReset()
    mermaid.render.mockResolvedValue({ svg: '<svg viewBox="0 0 10 10"><title>demo</title></svg>' })
    writeClipboard.mockClear()
    delete document.documentElement.dataset.theme
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { files: { open: vi.fn(), openLinked: vi.fn() }, native: { openExternal: vi.fn(), writeClipboard } } as unknown as AgentsDockAPI
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders a closed mermaid fence as a diagram with the SVG inserted', async () => {
    const { container } = render(<MarkdownContent text={FENCE} />)
    const diagram = await screen.findByRole('img', { name: 'Mermaid diagram' })
    expect(diagram.querySelector('svg title')?.textContent).toBe('demo')
    expect(container.querySelector('.mermaid-block pre')).toBeNull()
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-\d+$/), DEFINITION)
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'dark'
    }))
  })

  it('toggles back to the source and copies the full definition', async () => {
    const { container } = render(<MarkdownContent text={FENCE} />)
    await screen.findByRole('img', { name: 'Mermaid diagram' })
    fireEvent.click(screen.getByTitle('Show source'))
    expect(container.querySelector('.mermaid-block pre code')?.textContent).toContain(DEFINITION)
    expect(screen.queryByRole('img', { name: 'Mermaid diagram' })).toBeNull()
    fireEvent.click(screen.getByTitle('Show diagram'))
    expect(screen.getByRole('img', { name: 'Mermaid diagram' })).toBeInTheDocument()
    fireEvent.click(screen.getByTitle('Copy full code'))
    expect(writeClipboard).toHaveBeenCalledWith(DEFINITION)
  })

  it('uses the default mermaid theme for light mode and re-renders when the theme flips', async () => {
    document.documentElement.dataset.theme = 'light'
    render(<MarkdownContent text={FENCE} />)
    await screen.findByRole('img', { name: 'Mermaid diagram' })
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'default' }))
    act(() => { document.documentElement.dataset.theme = 'dark' })
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2))
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: 'dark' }))
  })

  it('falls back to the code block plus the parser message when mermaid rejects', async () => {
    mermaid.render.mockRejectedValue(new Error('Parse error on line 2: Expecting NEWLINE'))
    const { container } = render(<MarkdownContent text={FENCE} />)
    await screen.findByText('Mermaid could not render this diagram')
    expect(screen.getByText('Parse error on line 2: Expecting NEWLINE')).toBeInTheDocument()
    expect(container.querySelector('.mermaid-block pre code')?.textContent).toContain(DEFINITION)
    expect(screen.queryByRole('img', { name: 'Mermaid diagram' })).toBeNull()
    expect(screen.queryByTitle('Show source')).toBeNull()
    expect(screen.getByTitle('Copy full code')).toBeInTheDocument()
  })

  it('waits for an open fence to go idle instead of parsing every streamed chunk', async () => {
    vi.useFakeTimers()
    const { rerender } = render(<MarkdownContent text={'```mermaid\nflowchart LR\n  a --'} />)
    await vi.advanceTimersByTimeAsync(300)
    expect(mermaid.render).not.toHaveBeenCalled()
    rerender(<MarkdownContent text={'```mermaid\nflowchart LR\n  a --> b'} />)
    await vi.advanceTimersByTimeAsync(300)
    expect(mermaid.render).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    expect(mermaid.render).toHaveBeenLastCalledWith(expect.any(String), DEFINITION)
    // The closing fence arrives: a closed block renders without the idle wait.
    rerender(<MarkdownContent text={FENCE} />)
    await vi.advanceTimersByTimeAsync(0)
    expect(mermaid.render).toHaveBeenCalledTimes(2)
  })

  it('leaves other fenced blocks as plain code blocks', () => {
    const { container } = render(<MarkdownContent text={'```bash\necho hi\n```'} />)
    expect(container.querySelector('.code-block')).not.toBeNull()
    expect(container.querySelector('.mermaid-block')).toBeNull()
    expect(container.querySelector('.code-toolbar span')?.textContent).toBe('code')
    expect(mermaid.render).not.toHaveBeenCalled()
  })

  it('renders diagrams through the Markdown file preview renderer too', async () => {
    render(<SafeHtmlMarkdownContent text={`# Notes\n\n${FENCE}`} />)
    await screen.findByRole('img', { name: 'Mermaid diagram' })
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), DEFINITION)
  })
})
