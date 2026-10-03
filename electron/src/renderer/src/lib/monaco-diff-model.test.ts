import { describe, expect, it } from 'vitest'
import { buildMonacoDiffModel, languageIdForPath } from './monaco-diff-model'
import { parseReviewableDiff } from './unified-diff'

const gapLabel = (unchanged: number | null) => unchanged == null ? '⋯' : `⋯ ${unchanged} unchanged`
const file = (source: string[]) => parseReviewableDiff(source.join('\n'))[0]

describe('buildMonacoDiffModel', () => {
  it('rebuilds both sides hunk by hunk with one aligned placeholder between hunks', () => {
    const model = buildMonacoDiffModel(file([
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
      '@@ -4,3 +4,3 @@', ' keep4', '-old5', '+new5', ' keep6',
      '@@ -20,2 +20,3 @@', ' keep20', '+added', ' keep21'
    ]), gapLabel)!

    expect(model.original.split('\n')).toEqual(['keep4', 'old5', 'keep6', '⋯ 13 unchanged', 'keep20', 'keep21'])
    expect(model.modified.split('\n')).toEqual(['keep4', 'new5', 'keep6', '⋯ 13 unchanged', 'keep20', 'added', 'keep21'])
    expect(model.originalLineNumbers).toEqual([4, 5, 6, null, 20, 21])
    expect(model.modifiedLineNumbers).toEqual([4, 5, 6, null, 20, 21, 22])
    expect(model.conflicts).toEqual([])
  })

  it('counts the gap after a pure insertion hunk from the line the insertion follows', () => {
    const model = buildMonacoDiffModel(file([
      'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts',
      '@@ -2,0 +3,1 @@', '+inserted',
      '@@ -7,1 +8,1 @@', '-x', '+y'
    ]), gapLabel)!

    // Old lines 3..6 sit between the insertion point (after line 2) and line 7.
    expect(model.original.split('\n')).toEqual(['⋯ 4 unchanged', 'x'])
    expect(model.modified.split('\n')).toEqual(['inserted', '⋯ 4 unchanged', 'y'])
    expect(model.originalLineNumbers).toEqual([null, 7])
    expect(model.modifiedLineNumbers).toEqual([3, null, 8])
  })

  it('uses a bare placeholder when hunk headers carry no line numbers', () => {
    const model = buildMonacoDiffModel(file([
      '*** Update File: notes.md', '@@ first', '-a', '+b', '@@ second', ' c', '+d'
    ]), gapLabel)!

    expect(model.original.split('\n')).toEqual(['a', '⋯', 'c'])
    expect(model.modified.split('\n')).toEqual(['b', '⋯', 'c', 'd'])
    expect(model.originalLineNumbers).toEqual([1, null, 2])
    expect(model.modifiedLineNumbers).toEqual([1, null, 2, 3])
  })

  it('renders whole-file additions and deletions with an empty other side', () => {
    const added = buildMonacoDiffModel(file([
      'diff --git a/new.ts b/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+one', '+two'
    ]), gapLabel)!
    expect(added.original).toBe('')
    expect(added.originalLineNumbers).toEqual([])
    expect(added.modified).toBe('one\ntwo')
    expect(added.modifiedLineNumbers).toEqual([1, 2])

    const deleted = buildMonacoDiffModel(file([
      'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two'
    ]), gapLabel)!
    expect(deleted.modified).toBe('')
    expect(deleted.modifiedLineNumbers).toEqual([])
    expect(deleted.original).toBe('one\ntwo')
    expect(deleted.originalLineNumbers).toEqual([1, 2])
  })

  it('returns null for binary files so the pane keeps its textual note', () => {
    const binary = file(['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ'])
    expect(binary.lines.map(line => line.kind)).toEqual(['header', 'header'])
    expect(buildMonacoDiffModel(binary, gapLabel)).toBeNull()
  })

  it('maps conflict rows onto modified-side editor lines and drops the header rows', () => {
    const model = buildMonacoDiffModel(file([
      'diff --git a/c.ts b/c.ts', '--- a/c.ts', '+++ b/c.ts', '@@ -1,4 +1,5 @@',
      ' <<<<<<< HEAD', '-dropped', ' ours', ' =======', '+theirs', ' >>>>>>> feature', '\\ No newline at end of file'
    ]), gapLabel)!

    expect(model.modified.split('\n')).toEqual(['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature'])
    expect(model.conflicts).toEqual([
      { line: 1, side: 'ours', marker: 'start' },
      { line: 2, side: 'ours', marker: undefined },
      { line: 3, side: 'theirs', marker: 'separator' },
      { line: 4, side: 'theirs', marker: undefined },
      { line: 5, side: 'theirs', marker: 'end' }
    ])
  })

  it('strips CRLF carriage returns so rows stay one editor line each', () => {
    const model = buildMonacoDiffModel(file([
      'diff --git a/w.txt b/w.txt', '--- a/w.txt', '+++ b/w.txt', '@@ -1,2 +1,2 @@', ' same\r', '-old\r', '+new\r'
    ]), gapLabel)!
    expect(model.original).toBe('same\nold')
    expect(model.modified).toBe('same\nnew')
  })
})

describe('languageIdForPath', () => {
  const registered = [
    { id: 'typescript', extensions: ['.ts', '.tsx'] },
    { id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'] },
    { id: 'html', extensions: ['.html'] },
    { id: 'razor', extensions: ['.cshtml'] },
    { id: 'plaintext', extensions: ['.txt'] }
  ]

  it('matches by extension, case-insensitively, using only the basename', () => {
    expect(languageIdForPath('src/dir.ts/App.TSX', registered)).toBe('typescript')
    expect(languageIdForPath('index.html', registered)).toBe('html')
  })

  it('prefers exact filenames and the longest extension', () => {
    expect(languageIdForPath('deploy/Dockerfile', registered)).toBe('dockerfile')
    expect(languageIdForPath('view.cshtml', registered)).toBe('razor')
  })

  it('falls back to plaintext', () => {
    expect(languageIdForPath('LICENSE', registered)).toBe('plaintext')
    expect(languageIdForPath('archive.tar.gz', [])).toBe('plaintext')
  })
})
