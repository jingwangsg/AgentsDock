import { forwardRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import { CodeReview } from './CodeReview'

// jsdom cannot host Monaco. Rejecting its import exercises the line-based
// fallback, which is the renderer these assertions read.
vi.mock('monaco-editor/editor/editor.api', () => { throw new Error('monaco unavailable in jsdom') })

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function MockVirtuoso(props: {
    data: unknown[]
    computeItemKey: (index: number, item: unknown) => string
    itemContent: (index: number, item: unknown) => React.ReactNode
    className?: string
  }, _ref) {
    return <div className={props.className}>{props.data.map((item, index) => <div key={props.computeItemKey(index, item)}>{props.itemContent(index, item)}</div>)}</div>
  })
}))

describe('CodeReview', () => {
  afterEach(() => {
    cleanup()
    resetTransientCloseStackForTests()
    vi.restoreAllMocks()
  })

  it('renders the canonical patch as line-level code and a changed-file tree', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        diffs: { get: vi.fn().mockResolvedValue('diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -4 +4 @@\n-oldValue\n+newValue') },
        native: { writeClipboard: vi.fn() }
      } as unknown as AgentsDockAPI
    })

    render(<CodeReview target={{ sessionId: 'chat-1', runId: 'run-1', files: [{ path: 'src/example.ts', additions: 1, deletions: 1 }], additions: 1, deletions: 1, repositoryRoot: '/work/project' }} onClose={vi.fn()} />)

    expect(await screen.findByText('+newValue')).toBeInTheDocument()
    expect(screen.getByText('-oldValue')).toBeInTheDocument()
    expect(screen.getByText('The code editor could not load; showing the plain diff instead.')).toHaveAttribute('title')
    expect(screen.getByRole('region', { name: 'Code review' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Changed files' })).toBeInTheDocument()
    expect(screen.getAllByText('example.ts').length).toBeGreaterThan(0)
  })

  it('groups changed files into collapsible directories with aggregated counts and a flat toggle', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { diffs: { get: vi.fn() }, native: { writeClipboard: vi.fn() } } as unknown as AgentsDockAPI
    })
    const source = [
      'diff --git a/src/a/one.ts b/src/a/one.ts', '--- a/src/a/one.ts', '+++ b/src/a/one.ts', '@@ -1 +1 @@', '-old', '+new',
      'diff --git a/src/a/two.ts b/src/a/two.ts', '--- a/src/a/two.ts', '+++ b/src/a/two.ts', '@@ -0,0 +1,2 @@', '+x', '+y',
      'diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -0,0 +1 @@', '+hello'
    ].join('\n')
    const user = userEvent.setup()

    render(<CodeReview target={{ sessionId: 'chat-1', source }} onClose={vi.fn()} />)

    // The single-child chain src/a folds into one row that sums its two files.
    const directory = screen.getByRole('button', { name: 'src/a, 2 files, 3 additions, 1 deletions' })
    expect(directory).toHaveAttribute('aria-expanded', 'true')
    expect(directory).toHaveTextContent('src/a')
    expect(screen.getByText('3 files', { exact: true })).toBeInTheDocument()
    const one = screen.getByRole('button', { name: 'src/a/one.ts, 1 additions, 1 deletions' })
    expect(one).toHaveTextContent('one.ts')
    expect(one).not.toHaveTextContent('src/a/one.ts')
    expect(one).toHaveAttribute('title', 'src/a/one.ts')
    // Directories come first; the root-level file follows them.
    const rows = screen.getByRole('complementary', { name: 'Changed files' }).querySelectorAll('.review-tree button')
    expect([...rows].map(row => row.textContent)).toEqual(['src/a2+3-1', 'Mone.ts+1-1', 'Mtwo.ts+2-0', 'MREADME.md+1-0'])

    fireEvent.click(directory)
    expect(directory).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: 'src/a/one.ts, 1 additions, 1 deletions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'README.md, 1 additions, 0 deletions' })).toBeInTheDocument()

    directory.focus()
    await user.keyboard('{Enter}')
    expect(directory).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'src/a/two.ts, 2 additions, 0 deletions' })).toBeInTheDocument()
    await user.keyboard(' ')
    expect(directory).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Flat' }))
    expect(screen.getByRole('button', { name: 'Flat' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'src/a, 2 files, 3 additions, 1 deletions' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'src/a/one.ts, 1 additions, 1 deletions' })).toHaveTextContent('src/a/one.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }))
    // The collapsed state survives the round trip through the flat view.
    expect(screen.getByRole('button', { name: 'src/a, 2 files, 3 additions, 1 deletions' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('highlights complete merge conflicts throughout the review surface', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { diffs: { get: vi.fn() }, native: { writeClipboard: vi.fn() } } as unknown as AgentsDockAPI
    })
    const source = [
      'diff --git a/src/conflicted.ts b/src/conflicted.ts', '--- a/src/conflicted.ts', '+++ b/src/conflicted.ts', '@@ -1,7 +1,7 @@',
      ' <<<<<<< HEAD', ' ours', ' ||||||| parent', ' base', ' =======', ' theirs', ' >>>>>>> feature',
      'diff --git a/src/clean.ts b/src/clean.ts', '--- a/src/clean.ts', '+++ b/src/clean.ts', '@@ -1 +1 @@', '-old', '+new'
    ].join('\n')

    const view = render(<CodeReview target={{ sessionId: 'chat-1', source }} onClose={vi.fn()} />)

    expect(screen.getByRole('status')).toHaveTextContent('1 conflicted file · 1 conflict')
    const conflicted = screen.getByRole('button', { name: 'src/conflicted.ts, 1 conflict, 0 additions, 0 deletions' })
    const clean = screen.getByRole('button', { name: 'src/clean.ts, 1 additions, 1 deletions' })
    expect(await screen.findByRole('separator', { name: 'Merge conflict: ours section begins, HEAD' })).toHaveAttribute('data-conflict-side', 'ours')
    expect(screen.getByRole('separator', { name: 'Merge conflict: base section begins, parent' })).toHaveAttribute('data-conflict-side', 'base')
    expect(screen.getByRole('separator', { name: 'Merge conflict: theirs section begins' })).toHaveAttribute('data-conflict-side', 'theirs')
    expect(screen.getByRole('separator', { name: 'Merge conflict ends, feature' })).toHaveAttribute('data-conflict-side', 'theirs')
    expect(view.container.querySelectorAll('.diff-line[data-conflict-side]')).toHaveLength(7)
    fireEvent.click(clean)
    expect(clean).toHaveAttribute('aria-current', 'true')
    expect(conflicted).not.toHaveAttribute('aria-current')
  })

  it('does not style an incomplete conflict marker as a conflict', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { diffs: { get: vi.fn() }, native: { writeClipboard: vi.fn() } } as unknown as AgentsDockAPI
    })
    const source = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+<<<<<<< HEAD\n+unfinished'

    const view = render(<CodeReview target={{ sessionId: 'chat-1', source }} onClose={vi.fn()} />)

    expect(await screen.findByText('+unfinished')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(view.container.querySelector('[data-conflict-side]')).not.toBeInTheDocument()
  })

  it('refuses to dress a git status inventory up as a code diff', () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        diffs: { get: vi.fn() },
        native: { writeClipboard: vi.fn() }
      } as unknown as AgentsDockAPI
    })

    render(<CodeReview target={{ sessionId: 'chat-1', source: ' M src/example.ts\n?? src/new.ts' }} onClose={vi.fn()} />)

    expect(screen.getByText(/recorded a file list, but no line-level patch/i)).toBeInTheDocument()
    expect(screen.queryByText(' M src/example.ts')).not.toBeInTheDocument()
  })

  it('ignores a late diff response after the review switches chats', async () => {
    let resolveFirst: (value: string) => void = () => undefined
    const first = new Promise<string>(resolve => { resolveFirst = resolve })
    const get = vi.fn((sessionId: string) => sessionId === 'chat-1'
      ? first
      : Promise.resolve('diff --git a/chat-two.ts b/chat-two.ts\n--- a/chat-two.ts\n+++ b/chat-two.ts\n@@ -1 +1 @@\n-old\n+chatTwo'))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { diffs: { get }, native: { writeClipboard: vi.fn() } } as unknown as AgentsDockAPI
    })

    const view = render(<CodeReview target={{ sessionId: 'chat-1', runId: 'run-1' }} onClose={vi.fn()} />)
    view.rerender(<CodeReview target={{ sessionId: 'chat-2', runId: 'run-2' }} onClose={vi.fn()} />)
    expect(await screen.findByText('+chatTwo')).toBeInTheDocument()

    resolveFirst('diff --git a/chat-one.ts b/chat-one.ts\n--- a/chat-one.ts\n+++ b/chat-one.ts\n@@ -1 +1 @@\n-old\n+chatOne')
    await waitFor(() => expect(screen.queryByText('+chatOne')).not.toBeInTheDocument())
    expect(screen.getByText('+chatTwo')).toBeInTheDocument()
  })
})
