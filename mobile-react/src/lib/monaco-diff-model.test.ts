import assert from 'node:assert/strict'
import { parseReviewableDiff } from './code-review'
import { buildMonacoDiffModel, languageIdForPath } from './monaco-diff-model'

// Ported from electron/src/renderer/src/lib/monaco-diff-model.test.ts; the
// mobile parser must feed the same model builder the desktop pane uses.
const gapLabel = (unchanged: number | null) => unchanged == null ? '⋯' : `⋯ ${unchanged} unchanged`
const file = (source: string[]) => parseReviewableDiff(source.join('\n'))[0]

{
  // Rebuilds both sides hunk by hunk with one aligned placeholder between hunks.
  const model = buildMonacoDiffModel(file([
    'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -4,3 +4,3 @@', ' keep4', '-old5', '+new5', ' keep6',
    '@@ -20,2 +20,3 @@', ' keep20', '+added', ' keep21',
  ]), gapLabel)!
  assert.deepEqual(model.original.split('\n'), ['keep4', 'old5', 'keep6', '⋯ 13 unchanged', 'keep20', 'keep21'])
  assert.deepEqual(model.modified.split('\n'), ['keep4', 'new5', 'keep6', '⋯ 13 unchanged', 'keep20', 'added', 'keep21'])
  assert.deepEqual(model.originalLineNumbers, [4, 5, 6, null, 20, 21])
  assert.deepEqual(model.modifiedLineNumbers, [4, 5, 6, null, 20, 21, 22])
  assert.deepEqual(model.conflicts, [])
}

{
  // Counts the gap after a pure insertion hunk from the line the insertion follows:
  // old lines 3..6 sit between the insertion point (after line 2) and line 7.
  const model = buildMonacoDiffModel(file([
    'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts',
    '@@ -2,0 +3,1 @@', '+inserted',
    '@@ -7,1 +8,1 @@', '-x', '+y',
  ]), gapLabel)!
  assert.deepEqual(model.original.split('\n'), ['⋯ 4 unchanged', 'x'])
  assert.deepEqual(model.modified.split('\n'), ['inserted', '⋯ 4 unchanged', 'y'])
  assert.deepEqual(model.originalLineNumbers, [null, 7])
  assert.deepEqual(model.modifiedLineNumbers, [3, null, 8])
}

{
  // Uses a bare placeholder when hunk headers carry no line numbers.
  const model = buildMonacoDiffModel(file([
    '*** Update File: notes.md', '@@ first', '-a', '+b', '@@ second', ' c', '+d',
  ]), gapLabel)!
  assert.deepEqual(model.original.split('\n'), ['a', '⋯', 'c'])
  assert.deepEqual(model.modified.split('\n'), ['b', '⋯', 'c', 'd'])
  assert.deepEqual(model.originalLineNumbers, [1, null, 2])
  assert.deepEqual(model.modifiedLineNumbers, [1, null, 2, 3])
}

{
  // Whole-file additions and deletions leave the other side empty.
  const added = buildMonacoDiffModel(file([
    'diff --git a/new.ts b/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/new.ts', '@@ -0,0 +1,2 @@', '+one', '+two',
  ]), gapLabel)!
  assert.equal(added.original, '')
  assert.deepEqual(added.originalLineNumbers, [])
  assert.equal(added.modified, 'one\ntwo')
  assert.deepEqual(added.modifiedLineNumbers, [1, 2])

  const deleted = buildMonacoDiffModel(file([
    'diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two',
  ]), gapLabel)!
  assert.equal(deleted.modified, '')
  assert.deepEqual(deleted.modifiedLineNumbers, [])
  assert.equal(deleted.original, 'one\ntwo')
  assert.deepEqual(deleted.originalLineNumbers, [1, 2])
}

{
  // Binary files have no content rows, so the pane keeps its textual note.
  const binary = file(['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ'])
  assert.deepEqual(binary.lines.map(line => line.kind), ['header', 'header'])
  assert.equal(buildMonacoDiffModel(binary, gapLabel), null)
}

{
  // Conflict rows map onto modified-side editor lines; header rows are dropped.
  const model = buildMonacoDiffModel(file([
    'diff --git a/c.ts b/c.ts', '--- a/c.ts', '+++ b/c.ts', '@@ -1,4 +1,5 @@',
    ' <<<<<<< HEAD', '-dropped', ' ours', ' =======', '+theirs', ' >>>>>>> feature', '\\ No newline at end of file',
  ]), gapLabel)!
  assert.deepEqual(model.modified.split('\n'), ['<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature'])
  assert.deepEqual(model.conflicts, [
    { line: 1, side: 'ours', marker: 'start' },
    { line: 2, side: 'ours', marker: undefined },
    { line: 3, side: 'theirs', marker: 'separator' },
    { line: 4, side: 'theirs', marker: undefined },
    { line: 5, side: 'theirs', marker: 'end' },
  ])
}

{
  // CRLF carriage returns are stripped so rows stay one editor line each.
  const model = buildMonacoDiffModel(file([
    'diff --git a/w.txt b/w.txt', '--- a/w.txt', '+++ b/w.txt', '@@ -1,2 +1,2 @@', ' same\r', '-old\r', '+new\r',
  ]), gapLabel)!
  assert.equal(model.original, 'same\nold')
  assert.equal(model.modified, 'same\nnew')
}

{
  const registered = [
    { id: 'typescript', extensions: ['.ts', '.tsx'] },
    { id: 'dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile'] },
    { id: 'html', extensions: ['.html'] },
    { id: 'razor', extensions: ['.cshtml'] },
    { id: 'plaintext', extensions: ['.txt'] },
  ]
  // Matches by extension, case-insensitively, using only the basename.
  assert.equal(languageIdForPath('src/dir.ts/App.TSX', registered), 'typescript')
  assert.equal(languageIdForPath('index.html', registered), 'html')
  // Prefers exact filenames and the longest extension.
  assert.equal(languageIdForPath('deploy/Dockerfile', registered), 'dockerfile')
  assert.equal(languageIdForPath('view.cshtml', registered), 'razor')
  // Falls back to plaintext.
  assert.equal(languageIdForPath('LICENSE', registered), 'plaintext')
  assert.equal(languageIdForPath('archive.tar.gz', []), 'plaintext')
}

console.log('monaco diff model tests passed')
