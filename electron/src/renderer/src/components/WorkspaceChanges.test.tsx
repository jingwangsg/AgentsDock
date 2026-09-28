import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { WorkspaceGitStatus } from '@shared/workspace-git'
import { setLocale } from '@shared/i18n'
import { WorkspaceChanges } from './WorkspaceChanges'

vi.mock('react-virtuoso', () => ({ Virtuoso: ({ data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => React.ReactNode }) => <div>{data.map((item, index) => <div key={index}>{itemContent(index, item)}</div>)}</div> }))

// jsdom cannot run Monaco; this fake records what the diff preview asks of it.
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

const scope = { profileId: 'server-a', profileGeneration: 1, serverIdentity: 'identity-a' }
const modified = { path: 'app.ts', index_status: ' ', worktree_status: 'M', staged: false, unstaged: true, untracked: false, conflicted: false }
const initial: WorkspaceGitStatus = { root: '/workspace/project', branch: 'main', head: 'abc', revision: 'rev-1', operation: null, files: [modified], staged_count: 0, conflict_count: 0 }
const git = { status: vi.fn(), diff: vi.fn(), conflict: vi.fn(), action: vi.fn() }

beforeEach(() => {
  setLocale('en')
  vi.clearAllMocks()
  localStorage.clear()
  Object.values(git).forEach(mock => mock.mockReset())
  git.status.mockResolvedValue(initial)
  git.diff.mockImplementation((_scope, _session, path, view) => Promise.resolve({ path, view, diff: '--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new', revision: 'rev-1', binary: false, truncated: false }))
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { workspaceGit: git } as unknown as AgentsDockAPI })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Workspace changes', () => {
  it('loads on activation and stages then commits through scoped revision-checked actions', async () => {
    const view = render(<WorkspaceChanges scope={scope} sessionId="chat-a" active={false} />)
    expect(git.status).not.toHaveBeenCalled()
    view.rerender(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    await screen.findByRole('button', { name: 'Stage app.ts' })
    expect(git.diff).not.toHaveBeenCalled()
    const staged = { ...initial, revision: 'rev-2', staged_count: 1, files: [{ ...modified, staged: true, unstaged: false, index_status: 'M', worktree_status: ' ' }] }
    git.action.mockResolvedValueOnce(staged)
    fireEvent.click(screen.getByRole('button', { name: 'Stage app.ts' }))
    await screen.findByRole('button', { name: 'Unstage app.ts' })
    expect(git.action).toHaveBeenLastCalledWith(scope, 'chat-a', { action: 'stage', paths: ['app.ts'], expected_revision: 'rev-1' })
    fireEvent.click(screen.getByRole('button', { name: 'Review commit' }))
    await waitFor(() => expect(shownModels()?.modified.value).toBe('new'))
    expect(git.diff).toHaveBeenLastCalledWith(scope, 'chat-a', 'app.ts', 'staged')
    const reads = git.status.mock.calls.length
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'Fix app' } })
    expect(git.status).toHaveBeenCalledTimes(reads)
    git.action.mockResolvedValueOnce({ ...staged, revision: 'rev-3', files: [], staged_count: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Commit staged changes' }))
    await screen.findByText('Changes committed.')
    expect(git.action).toHaveBeenLastCalledWith(scope, 'chat-a', { action: 'commit', message: 'Fix app', expected_revision: 'rev-2' })
  })

  it('groups changed files into collapsible directories and persists the flat toggle', async () => {
    git.status.mockResolvedValue({ ...initial, files: [
      { ...modified, path: 'src/a/one.ts' },
      { ...modified, path: 'src/a/two.ts' },
      { ...modified, path: 'README.md', untracked: true, unstaged: false, index_status: '?', worktree_status: '?' }
    ] })
    const view = render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    const rowLabels = () => [...view.container.querySelectorAll('.workspace-changes-directory, .workspace-changes-file-name')].map(row => row.getAttribute('aria-label'))

    // The single-child chain src/a folds into one row; directories come before files.
    const directory = await screen.findByRole('button', { name: 'src/a, 2 files' })
    expect(directory).toHaveAttribute('aria-expanded', 'true')
    expect(directory).toHaveTextContent('src/a2')
    expect(rowLabels()).toEqual(['src/a, 2 files', 'src/a/one.ts', 'src/a/two.ts', 'README.md'])
    const one = screen.getByRole('button', { name: 'src/a/one.ts' })
    expect(one).toHaveTextContent('one.ts')
    expect(one).not.toHaveTextContent('src/a/one.ts')
    expect(one).toHaveAttribute('title', 'src/a/one.ts')
    expect(screen.getByRole('button', { name: 'Stage src/a/one.ts' })).toBeInTheDocument()
    fireEvent.click(one)
    expect(one.closest('.workspace-changes-file')).toHaveClass('selected')

    fireEvent.click(directory)
    expect(directory).toHaveAttribute('aria-expanded', 'false')
    expect(rowLabels()).toEqual(['src/a, 2 files', 'README.md'])

    fireEvent.click(screen.getByRole('button', { name: 'Flat' }))
    expect(localStorage.getItem('agentsdock:changes-tree-view')).toBe('0')
    expect(rowLabels()).toEqual(['src/a/one.ts', 'src/a/two.ts', 'README.md'])
    expect(screen.getByRole('button', { name: 'src/a/one.ts' })).toHaveTextContent('src/a/one.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Tree' }))
    expect(localStorage.getItem('agentsdock:changes-tree-view')).toBe('1')
    // The collapsed state survives the round trip through the flat view.
    expect(screen.getByRole('button', { name: 'src/a, 2 files' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders the selected diff in the code editor and shares layout settings with the review pane', async () => {
    localStorage.setItem('agentsdock:review-side-by-side', '0')
    render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    fireEvent.click(await screen.findByRole('button', { name: 'app.ts' }))
    await waitFor(() => expect(shownModels()?.modified.value).toBe('new'))
    expect(fake.monaco.editor.createDiffEditor).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({ readOnly: true }))
    expect(shownModels()?.original).toMatchObject({ value: 'old', language: 'typescript' })
    expect(fake.diffEditor.updateOptions).toHaveBeenLastCalledWith({ renderSideBySide: false, diffWordWrap: 'off' })
    expect(screen.queryByText('+new')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }))
    expect(fake.diffEditor.updateOptions).toHaveBeenLastCalledWith({ renderSideBySide: true, diffWordWrap: 'off' })
    expect(localStorage.getItem('agentsdock:review-side-by-side')).toBe('1')
    fireEvent.click(screen.getByRole('button', { name: 'Wrap' }))
    expect(fake.diffEditor.updateOptions).toHaveBeenLastCalledWith({ renderSideBySide: true, diffWordWrap: 'on' })
    expect(localStorage.getItem('agentsdock:review-word-wrap')).toBe('1')
    // Layout changes must not rebuild the documents.
    expect(fake.diffEditor.setModel.mock.calls.filter(call => call[0])).toHaveLength(1)
  })

  it('renders a truncated diff in the code editor below the truncated note and keeps the binary notice', async () => {
    git.status.mockResolvedValue({ ...initial, files: [modified, { ...modified, path: 'logo.png' }] })
    git.diff.mockImplementation((_scope, _session, path, view) => Promise.resolve(path === 'logo.png'
      ? { path, view, diff: 'Binary files a/logo.png and b/logo.png differ', revision: 'rev-1', binary: true, truncated: false }
      : { path, view, diff: '--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new', revision: 'rev-1', binary: false, truncated: true }))
    render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    fireEvent.click(await screen.findByRole('button', { name: 'app.ts' }))
    await waitFor(() => expect(shownModels()?.modified.value).toBe('new'))
    expect(screen.getByText('Preview truncated. Review the complete file before committing.')).toBeInTheDocument()
    expect(screen.queryByText('+new')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'logo.png' }))
    expect(await screen.findByText('Binary content cannot be previewed here.')).toBeInTheDocument()
  })

  it('shows the block for the selected path when the diff carries several file blocks', async () => {
    git.diff.mockImplementation((_scope, _session, path, view) => Promise.resolve({ path, view, revision: 'rev-1', binary: false, truncated: false, diff: [
      'diff --git a/legacy.ts b/legacy.ts', '--- a/legacy.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-gone',
      'diff --git a/app.ts b/app.ts', '--- /dev/null', '+++ b/app.ts', '@@ -0,0 +1 @@', '+arrived'
    ].join('\n') }))
    render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    fireEvent.click(await screen.findByRole('button', { name: 'app.ts' }))
    await waitFor(() => expect(shownModels()?.modified.value).toBe('arrived'))
    expect(shownModels()?.original.value).toBe('')
  })

  it('ignores a late snapshot after changing profile ownership', async () => {
    let resolve!: (status: WorkspaceGitStatus) => void
    git.status.mockReturnValueOnce(new Promise<WorkspaceGitStatus>(done => { resolve = done }))
    const view = render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    const otherScope = { ...scope, profileId: 'server-b', profileGeneration: 2 }
    git.status.mockResolvedValueOnce({ ...initial, root: '/workspace/other', branch: 'other-branch', files: [] })
    view.rerender(<WorkspaceChanges scope={otherScope} sessionId="chat-b" />)
    await screen.findByText('other-branch')
    await act(async () => resolve(initial))
    expect(screen.queryByText('main')).not.toBeInTheDocument()
    expect(git.status).toHaveBeenLastCalledWith(otherScope, 'chat-b')
  })

  it('preserves a conflict draft on refresh and prevents saving it against a newer repository revision', async () => {
    const conflicted = { ...initial, operation: 'merge' as const, conflict_count: 1, files: [{ ...modified, conflicted: true, index_status: 'U', worktree_status: 'U' }] }
    git.status.mockResolvedValue(conflicted)
    git.conflict.mockResolvedValue({ path: 'app.ts', base: 'base', ours: 'current', theirs: 'incoming', result: '<<<<<<< HEAD\ncurrent\n=======\nincoming\n>>>>>>> incoming', binary: false, revision: 'rev-1' })
    render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    fireEvent.click(await screen.findByRole('button', { name: /app.ts/ }))
    fireEvent.change(await screen.findByLabelText('Resolved result'), { target: { value: 'my resolution' } })
    git.status.mockResolvedValueOnce({ ...conflicted, revision: 'rev-2' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh changes' }))
    await screen.findByText(/The repository changed/)
    expect(screen.getByLabelText('Resolved result')).toHaveValue('my resolution')
    expect(screen.getByRole('button', { name: 'Save resolution' })).toBeDisabled()
    expect(git.conflict).toHaveBeenCalledTimes(1)
    expect(git.action).not.toHaveBeenCalled()
  })

  it('requires an explicit abort confirmation and sends confirmed authority once', async () => {
    git.status.mockResolvedValue({ ...initial, operation: 'merge' })
    git.action.mockResolvedValue({ ...initial, revision: 'rev-2' })
    render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Abort merge' }))
    expect(git.action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(git.action).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Abort merge' }))
    fireEvent.click(screen.getByRole('button', { name: 'Abort operation' }))
    await waitFor(() => expect(git.action).toHaveBeenCalledExactlyOnceWith(scope, 'chat-a', { action: 'abort', confirmed: true, expected_revision: 'rev-1' }))
    await screen.findByText('Operation aborted.')
  })

  it('keeps a rebase open when continuing reaches the next conflict', async () => {
    git.status.mockResolvedValue({ ...initial, operation: 'rebase', files: [] })
    git.action.mockResolvedValue({ ...initial, revision: 'rev-2', operation: 'rebase', conflict_count: 1, files: [{ ...modified, conflicted: true }] })
    render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue rebase' }))
    await screen.findByText('More conflicts to resolve.')
    expect(screen.queryByText('Operation completed.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue rebase' })).toBeDisabled()
  })

  // Kept last: re-registering the Monaco mock affects every later lazy import in this file.
  it('shows one notice and no diff text when the code editor cannot load', async () => {
    vi.doMock('monaco-editor/editor/editor.api', () => { throw new Error('monaco unavailable in jsdom') })
    // The lazy ../lib/monaco module is cached from earlier tests; drop it so the next import re-evaluates.
    vi.resetModules()
    render(<WorkspaceChanges scope={scope} sessionId="chat-a" />)
    fireEvent.click(await screen.findByRole('button', { name: 'app.ts' }))
    const notice = await screen.findByText('The code editor could not load.')
    expect(notice).toHaveAttribute('title')
    expect(screen.queryByText(/\+new|-old/)).not.toBeInTheDocument()
    expect(fake.monaco.editor.createDiffEditor).not.toHaveBeenCalled()
  })
})
