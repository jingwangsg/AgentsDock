import assert from 'node:assert/strict'
import type { WorkspaceGitFile } from '../types'
import {
  CHANGES_FILTERS,
  countChanges,
  defaultDetailView,
  fileHasView,
  filterChanges,
  gitErrorCode,
  retriesStaleGitAction,
  stageablePaths,
  unstageablePaths,
} from './workspace-changes'

const file = (path: string, patch: Partial<WorkspaceGitFile> = {}): WorkspaceGitFile => ({
  path, index_status: ' ', worktree_status: ' ', staged: false, unstaged: false, untracked: false, conflicted: false, ...patch,
})

const files = [
  file('src/app.ts', { index_status: 'M', worktree_status: 'M', staged: true, unstaged: true }),
  file('src/lib/util.ts', { index_status: 'A', staged: true }),
  file('README.md', { worktree_status: 'M', unstaged: true }),
  file('notes.txt', { index_status: '?', worktree_status: '?', untracked: true }),
  file('src/merge.ts', { index_status: 'U', worktree_status: 'U', staged: true, unstaged: true, conflicted: true }),
  file('docs/new-name.md', { original_path: 'docs/old-name.md', index_status: 'R', staged: true }),
]

// Counting follows the desktop grouping: a conflicted file counts only under
// Conflicts, an untracked one only under Untracked, and a partially staged
// file under both Staged and Unstaged.
assert.deepEqual(countChanges(files), { all: 6, staged: 3, unstaged: 2, untracked: 1, conflicts: 1 })
assert.deepEqual(CHANGES_FILTERS, ['all', 'staged', 'unstaged', 'untracked', 'conflicts'])

// Filtering keeps input order and matches the path case-insensitively.
assert.deepEqual(filterChanges(files, 'all', '').map(item => item.path), files.map(item => item.path))
assert.deepEqual(filterChanges(files, 'staged', '').map(item => item.path), ['src/app.ts', 'src/lib/util.ts', 'docs/new-name.md'])
assert.deepEqual(filterChanges(files, 'unstaged', '').map(item => item.path), ['src/app.ts', 'README.md'])
assert.deepEqual(filterChanges(files, 'untracked', '').map(item => item.path), ['notes.txt'])
assert.deepEqual(filterChanges(files, 'conflicts', '').map(item => item.path), ['src/merge.ts'])
assert.deepEqual(filterChanges(files, 'all', '  SRC/LIB ').map(item => item.path), ['src/lib/util.ts'])
assert.deepEqual(filterChanges(files, 'staged', 'readme'), [], 'the group filter and the query both apply')

// Which side a tap opens.
assert.equal(defaultDetailView(files[0], 'all'), 'unstaged', 'a partially staged file opens on the working tree by default')
assert.equal(defaultDetailView(files[0], 'staged'), 'staged', 'the Staged group opens the index side')
assert.equal(defaultDetailView(files[1], 'all'), 'staged', 'a file with only an index change opens staged')
assert.equal(defaultDetailView(files[3], 'all'), 'unstaged', 'an untracked file reads as a working-tree change')
assert.equal(defaultDetailView(files[4], 'staged'), 'conflict', 'a conflict is never shown as a plain diff')
assert.equal(fileHasView(files[3], 'unstaged'), true)
assert.equal(fileHasView(files[3], 'staged'), false)
assert.equal(fileHasView(files[4], 'staged'), false, 'a conflicted file has no stageable side')
assert.equal(fileHasView(files[4], 'conflict'), true)

// Bulk actions never touch conflicted files.
assert.deepEqual(stageablePaths(files), ['src/app.ts', 'README.md', 'notes.txt'])
assert.deepEqual(unstageablePaths(files), ['src/app.ts', 'src/lib/util.ts', 'docs/new-name.md'])

// Error classification reads the server detail code structurally.
const stale = { status: 409, detail: { code: 'git_stale_revision', message: 'Repository changed since review.' } }
assert.equal(gitErrorCode(stale), 'git_stale_revision')
assert.equal(gitErrorCode({ status: 422, detail: { code: 'workspace_not_git' } }), 'workspace_not_git')
assert.equal(gitErrorCode({ status: 500, detail: 'plain text' }), null)
assert.equal(gitErrorCode(new Error('network')), null)
assert.equal(gitErrorCode(null), null)

// Only a stale stage/unstage is retried; other 409s and other actions surface.
assert.equal(retriesStaleGitAction('stage', stale), true)
assert.equal(retriesStaleGitAction('unstage', stale), true)
assert.equal(retriesStaleGitAction('commit', stale), false, 'a commit depends on what was reviewed')
assert.equal(retriesStaleGitAction('resolve', stale), false)
assert.equal(retriesStaleGitAction('stage', { status: 409, detail: { code: 'git_busy' } }), false)
assert.equal(retriesStaleGitAction('stage', { status: 422, detail: { code: 'git_stale_revision' } }), false)
assert.equal(retriesStaleGitAction('stage', new Error('offline')), false)

console.log('workspace changes helpers passed')
