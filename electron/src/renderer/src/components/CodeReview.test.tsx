import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import { CodeReview } from './CodeReview'

// jsdom cannot run Monaco; this fake records what the review pane asks of it.
const fake = vi.hoisted(() => {
  const sideEditor = () => ({ updateOptions: vi.fn(), createDecorationsCollection: vi.fn() })
  const diffEditor = {
    setModel: vi.fn(),
    updateOptions: vi.fn(),
    dispose: vi.fn(),
    original: sideEditor(),
    modified: sideEditor(),
    getOriginalEditor() { return this.original },
    getModifiedEditor() { return this.modified }
  }
  const monaco = {
    editor: {
      createDiffEditor: vi.fn(() => diffEditor),
      createModel: vi.fn((value: string, language: string) => ({ value, language, dispose: vi.fn() })),
      defineTheme: vi.fn(),
      setTheme: vi.fn()
    },
    languages: { getLanguages: () => [{ id: 'typescript', extensions: ['.ts'] }] },
    Range: class { constructor(readonly startLineNumber: number, readonly startColumn: number, readonly endLineNumber: number, readonly endColumn: number) {} }
  }
  return { diffEditor, monaco }
})

vi.mock('monaco-editor/editor/editor.api', () => fake.monaco)
vi.mock('monaco-editor/basic-languages/monaco.contribution', () => ({}))
vi.mock('monaco-editor/editor/editor.worker?worker', () => ({ default: class {} }))

type FakeModel = { value: string; language: string }
// setModel(null) precedes every swap; the last non-null call holds the documents on screen.
const shownModels = () => fake.diffEditor.setModel.mock.calls.map(call => call[0] as { original: FakeModel; modified: FakeModel } | null).filter(Boolean).at(-1)
// The modified side receives its gap rows first and the conflict rows last.
const conflictDecorations = () => (fake.diffEditor.modified.createDecorationsCollection.mock.calls.at(-1)?.[0] ?? []) as Array<{ options: { className: string; inlineClassName?: string } }>

describe('CodeReview', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    resetTransientCloseStackForTests()
    vi.restoreAllMocks()
  })

  it('renders the canonical patch in the code editor and a changed-file tree', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        diffs: { get: vi.fn().mockResolvedValue('diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -4 +4 @@\n-oldValue\n+newValue') },
        native: { writeClipboard: vi.fn() }
      } as unknown as AgentsDockAPI
    })

    render(<CodeReview target={{ sessionId: 'chat-1', runId: 'run-1', files: [{ path: 'src/example.ts', additions: 1, deletions: 1 }], additions: 1, deletions: 1, repositoryRoot: '/work/project' }} onClose={vi.fn()} />)

    await waitFor(() => expect(shownModels()?.modified.value).toBe('newValue'))
    expect(shownModels()?.original).toMatchObject({ value: 'oldValue', language: 'typescript' })
    expect(fake.monaco.editor.createDiffEditor).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ readOnly: true }))
    expect(screen.queryByText('+newValue')).not.toBeInTheDocument()
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

    render(<CodeReview target={{ sessionId: 'chat-1', source }} onClose={vi.fn()} />)

    expect(screen.getByRole('status')).toHaveTextContent('1 conflicted file · 1 conflict')
    const conflicted = screen.getByRole('button', { name: 'src/conflicted.ts, 1 conflict, 0 additions, 0 deletions' })
    const clean = screen.getByRole('button', { name: 'src/clean.ts, 1 additions, 1 deletions' })
    await waitFor(() => expect(shownModels()?.modified.value).toBe('<<<<<<< HEAD\nours\n||||||| parent\nbase\n=======\ntheirs\n>>>>>>> feature'))
    // Every row of the complete conflict is painted with its side; the four marker rows are emphasised.
    expect(conflictDecorations().map(decoration => decoration.options.className)).toEqual([
      'review-monaco-conflict ours', 'review-monaco-conflict ours',
      'review-monaco-conflict base', 'review-monaco-conflict base',
      'review-monaco-conflict theirs', 'review-monaco-conflict theirs', 'review-monaco-conflict theirs'
    ])
    expect(conflictDecorations().filter(decoration => decoration.options.inlineClassName === 'review-monaco-conflict-marker')).toHaveLength(4)
    fireEvent.click(clean)
    expect(clean).toHaveAttribute('aria-current', 'true')
    expect(conflicted).not.toHaveAttribute('aria-current')
    await waitFor(() => expect(shownModels()?.modified.value).toBe('new'))
  })

  it('does not style an incomplete conflict marker as a conflict', async () => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { diffs: { get: vi.fn() }, native: { writeClipboard: vi.fn() } } as unknown as AgentsDockAPI
    })
    const source = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,2 @@\n+<<<<<<< HEAD\n+unfinished'

    render(<CodeReview target={{ sessionId: 'chat-1', source }} onClose={vi.fn()} />)

    await waitFor(() => expect(shownModels()?.modified.value).toBe('<<<<<<< HEAD\nunfinished'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(conflictDecorations()).toEqual([])
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
    await waitFor(() => expect(shownModels()?.modified.value).toBe('chatTwo'))

    await act(async () => resolveFirst('diff --git a/chat-one.ts b/chat-one.ts\n--- a/chat-one.ts\n+++ b/chat-one.ts\n@@ -1 +1 @@\n-old\n+chatOne'))
    expect(shownModels()?.modified.value).toBe('chatTwo')
    expect(fake.monaco.editor.createModel).not.toHaveBeenCalledWith('chatOne', expect.anything())
  })

  // Kept last: re-registering the Monaco mock affects every later lazy import in this file.
  it('shows one notice and no diff text when the code editor cannot load', async () => {
    vi.doMock('monaco-editor/editor/editor.api', () => { throw new Error('monaco unavailable in jsdom') })
    // The lazy ../lib/monaco module is cached from earlier tests; drop it so the next import re-evaluates.
    vi.resetModules()
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: { diffs: { get: vi.fn() }, native: { writeClipboard: vi.fn() } } as unknown as AgentsDockAPI
    })

    render(<CodeReview target={{ sessionId: 'chat-1', source: 'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -4 +4 @@\n-oldValue\n+newValue' }} onClose={vi.fn()} />)

    const notice = await screen.findByText('The code editor could not load.')
    expect(notice).toHaveAttribute('title')
    expect(screen.queryByText(/oldValue|newValue/)).not.toBeInTheDocument()
    expect(fake.monaco.editor.createDiffEditor).not.toHaveBeenCalled()
    // Only the editor is replaced: the file header and layout toggles stay.
    expect(screen.getByText('src/example.ts', { selector: '.review-file-path' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inline' })).toBeInTheDocument()
  })
})
