import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildMonacoDiffModel } from '../lib/monaco-diff-model'
import { parseReviewableDiff } from '../lib/unified-diff'
import { MonacoDiffEditor } from './MonacoDiffEditor'

// jsdom cannot run Monaco; this fake records what the host component asks of it.
const fake = vi.hoisted(() => {
  const sideEditor = () => ({ updateOptions: vi.fn(), createDecorationsCollection: vi.fn() })
  const state = { disposed: false }
  const diffEditor = {
    // Real Monaco throws "InstantiationService has been disposed" when a disposed editor is touched.
    setModel: vi.fn((_models: unknown) => { if (state.disposed) throw new Error('InstantiationService has been disposed') }),
    updateOptions: vi.fn(),
    dispose: vi.fn(() => { state.disposed = true }),
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
  return { diffEditor, monaco, state }
})

vi.mock('monaco-editor/editor/editor.api', () => fake.monaco)
vi.mock('monaco-editor/basic-languages/monaco.contribution', () => ({}))
vi.mock('monaco-editor/editor/editor.worker?worker', () => ({ default: class {} }))

const modelFor = (source: string[]) => {
  const file = parseReviewableDiff(source.join('\n'))[0]
  return { file, model: buildMonacoDiffModel(file, unchanged => `⋯ ${unchanged}`)! }
}
type FakeModel = { value: string; language: string; dispose: ReturnType<typeof vi.fn> }
const setModelCall = (index: number) => fake.diffEditor.setModel.mock.calls[index][0] as { original: FakeModel; modified: FakeModel } | null

describe('MonacoDiffEditor', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    fake.state.disposed = false
    delete document.documentElement.dataset.theme
  })

  it('creates a read-only diff editor over both reconstructed sides with real gutter numbers', async () => {
    const { file, model } = modelFor([
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
      '@@ -4,2 +4,2 @@', ' keep', '-old', '+new',
      '@@ -20 +20 @@', '-x', '+y'
    ])

    render(<MonacoDiffEditor path={file.path} model={model} sideBySide wordWrap={false} onUnavailable={vi.fn()} />)

    await waitFor(() => expect(fake.diffEditor.setModel).toHaveBeenCalledTimes(1))
    expect(fake.monaco.editor.createDiffEditor).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({
      readOnly: true, automaticLayout: true, scrollBeyondLastLine: false, minimap: { enabled: false }, ignoreTrimWhitespace: false
    }))
    const models = setModelCall(0)!
    expect(models.original).toMatchObject({ value: 'keep\nold\n⋯ 14\nx', language: 'typescript' })
    expect(models.modified).toMatchObject({ value: 'keep\nnew\n⋯ 14\ny', language: 'typescript' })
    const originalNumbers = fake.diffEditor.original.updateOptions.mock.calls[0][0].lineNumbers as (line: number) => string
    const modifiedNumbers = fake.diffEditor.modified.updateOptions.mock.calls[0][0].lineNumbers as (line: number) => string
    expect([1, 2, 3, 4, 5].map(originalNumbers)).toEqual(['4', '5', '', '20', ''])
    expect([1, 2, 3, 4].map(modifiedNumbers)).toEqual(['4', '5', '', '20'])
    // The placeholder row is decorated on both sides so it reads as a gap, not code.
    for (const side of [fake.diffEditor.original, fake.diffEditor.modified]) {
      expect(side.createDecorationsCollection).toHaveBeenCalledWith([
        { range: expect.objectContaining({ startLineNumber: 3, endLineNumber: 3 }), options: { isWholeLine: true, className: 'review-monaco-gap', inlineClassName: 'review-monaco-gap-text' } }
      ])
    }
    expect(fake.diffEditor.updateOptions).toHaveBeenCalledWith({ renderSideBySide: true, diffWordWrap: 'off' })
    expect(fake.monaco.editor.setTheme).toHaveBeenCalledWith('agentsdock-dark')
  })

  it('disposes the previous models when the file changes and everything on unmount', async () => {
    const first = modelFor(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-a', '+b'])
    const second = modelFor(['diff --git a/b.py b/b.py', '--- a/b.py', '+++ b/b.py', '@@ -1 +1 @@', '-c', '+d'])
    const view = render(<MonacoDiffEditor path={first.file.path} model={first.model} sideBySide wordWrap={false} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(fake.diffEditor.setModel).toHaveBeenCalledTimes(1))
    const firstModels = setModelCall(0)!

    view.rerender(<MonacoDiffEditor path={second.file.path} model={second.model} sideBySide wordWrap={false} onUnavailable={vi.fn()} />)

    expect(fake.diffEditor.setModel).toHaveBeenCalledTimes(3)
    expect(setModelCall(1)).toBeNull()
    expect(firstModels.original.dispose).toHaveBeenCalledTimes(1)
    expect(firstModels.modified.dispose).toHaveBeenCalledTimes(1)
    const secondModels = setModelCall(2)!
    expect(secondModels.original).toMatchObject({ value: 'c', language: 'plaintext' })
    expect(secondModels.modified).toMatchObject({ value: 'd', language: 'plaintext' })
    expect(fake.diffEditor.dispose).not.toHaveBeenCalled()

    // Closing the Review pane once blanked the whole app: the editor was disposed first and the
    // model cleanup then called setModel(null) on it.
    expect(() => view.unmount()).not.toThrow()

    expect(secondModels.original.dispose).toHaveBeenCalledTimes(1)
    expect(secondModels.modified.dispose).toHaveBeenCalledTimes(1)
    expect(fake.diffEditor.dispose).toHaveBeenCalledTimes(1)
    expect(fake.diffEditor.setModel).toHaveBeenCalledTimes(3)
  })

  it('applies layout and wrap changes and follows the document theme', async () => {
    document.documentElement.dataset.theme = 'light'
    const { file, model } = modelFor(['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-a', '+b'])
    const view = render(<MonacoDiffEditor path={file.path} model={model} sideBySide wordWrap={false} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(fake.monaco.editor.setTheme).toHaveBeenCalledWith('agentsdock-light'))

    view.rerender(<MonacoDiffEditor path={file.path} model={model} sideBySide={false} wordWrap onUnavailable={vi.fn()} />)
    expect(fake.diffEditor.updateOptions).toHaveBeenLastCalledWith({ renderSideBySide: false, diffWordWrap: 'on' })
    // Toggling the layout must not rebuild the models.
    expect(fake.diffEditor.setModel).toHaveBeenCalledTimes(1)

    document.documentElement.dataset.theme = 'dark'
    await waitFor(() => expect(fake.monaco.editor.setTheme).toHaveBeenLastCalledWith('agentsdock-dark'))
  })

  it('decorates merge-conflict rows on the modified side', async () => {
    const { file, model } = modelFor([
      'diff --git a/c.ts b/c.ts', '--- a/c.ts', '+++ b/c.ts', '@@ -1,3 +1,3 @@',
      ' <<<<<<< HEAD', ' ours', ' =======', '+theirs', ' >>>>>>> feature'
    ])
    render(<MonacoDiffEditor path={file.path} model={model} sideBySide wordWrap={false} onUnavailable={vi.fn()} />)
    await waitFor(() => expect(fake.diffEditor.setModel).toHaveBeenCalledTimes(1))

    const decorations = fake.diffEditor.modified.createDecorationsCollection.mock.calls.flatMap(call => call[0] as Array<{ range: { startLineNumber: number }; options: object }>)
    expect(decorations.map(decoration => [decoration.range.startLineNumber, decoration.options])).toEqual([
      [1, { isWholeLine: true, className: 'review-monaco-conflict ours', inlineClassName: 'review-monaco-conflict-marker' }],
      [2, { isWholeLine: true, className: 'review-monaco-conflict ours', inlineClassName: undefined }],
      [3, { isWholeLine: true, className: 'review-monaco-conflict theirs', inlineClassName: 'review-monaco-conflict-marker' }],
      [4, { isWholeLine: true, className: 'review-monaco-conflict theirs', inlineClassName: undefined }],
      [5, { isWholeLine: true, className: 'review-monaco-conflict theirs', inlineClassName: 'review-monaco-conflict-marker' }]
    ])
    expect(fake.diffEditor.original.createDecorationsCollection).toHaveBeenCalledWith([])
  })
})
