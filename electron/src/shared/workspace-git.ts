/** Repository-wide state, not a single chat turn's recorded patch. */
export interface WorkspaceGitFile {
  path: string
  original_path?: string
  index_status: string
  worktree_status: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
  conflicted: boolean
}
export interface WorkspaceGitStatus {
  root: string
  branch: string | null
  head: string | null
  revision: string
  operation: null | 'merge' | 'rebase' | 'cherry-pick' | 'revert'
  files: WorkspaceGitFile[]
  staged_count: number
  conflict_count: number
}
export type WorkspaceGitView = 'staged' | 'unstaged'
export interface WorkspaceGitDiff {
  path: string
  view: WorkspaceGitView
  diff: string
  binary: boolean
  truncated: boolean
  revision: string
}
export interface WorkspaceGitConflict {
  path: string
  base: string | null
  ours: string | null
  theirs: string | null
  result: string
  revision: string
  binary: boolean
}
/** One end of a comparison: the working tree (`WORKTREE`), the index (`INDEX`), or a revision (commit, branch, tag). */
export const WORKSPACE_GIT_WORKTREE = 'WORKTREE'
export const WORKSPACE_GIT_INDEX = 'INDEX'
export interface WorkspaceGitCommit { hash: string; short: string; author: string; date: string; subject: string }
export interface WorkspaceGitRefs { head: string | null; branch: string | null; commits: WorkspaceGitCommit[]; branches: string[]; tags: string[] }
export interface WorkspaceGitPoint { ref: string; resolved: string | null }
export interface WorkspaceGitCompareFile { path: string; status: string; untracked: boolean }
export interface WorkspaceGitCompare { base: WorkspaceGitPoint; target: WorkspaceGitPoint; files: WorkspaceGitCompareFile[]; truncated: boolean }
export interface WorkspaceGitCompareDiff { path: string; base: string; target: string; diff: string; binary: boolean; truncated: boolean }
/** A comparison end the server accepts: `WORKTREE`, `INDEX`, or a revision name that is neither an option nor a range. */
export function workspaceGitPointRef(value: string): string {
  if (value === WORKSPACE_GIT_WORKTREE || value === WORKSPACE_GIT_INDEX) return value
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/@{}^~-]{0,255}$/.test(value) || value.includes('..')) {
    throw new Error('Name a commit, branch or tag to compare.')
  }
  return value
}
export interface WorkspaceGitAction {
  action: 'stage' | 'unstage' | 'discard' | 'commit' | 'resolve' | 'continue' | 'abort'
  expected_revision: string
  paths?: string[]
  message?: string
  path?: string
  content?: string
  confirmed?: boolean
}
export function workspaceGitSessionId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Invalid workspace chat.')
  return value
}
export function workspaceGitPath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.includes('\0')
    || value.startsWith('/') || value.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('Invalid repository file path.')
  }
  return value
}
export function validateWorkspaceGitAction(input: WorkspaceGitAction): WorkspaceGitAction {
  if (!input || !['stage', 'unstage', 'discard', 'commit', 'resolve', 'continue', 'abort'].includes(input.action)
    || typeof input.expected_revision !== 'string' || !input.expected_revision || input.expected_revision.length > 256) {
    throw new Error('Refresh Changes before making a Git change.')
  }
  const result: WorkspaceGitAction = { action: input.action, expected_revision: input.expected_revision }
  if (input.action === 'stage' || input.action === 'unstage' || input.action === 'discard') {
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 1000) throw new Error('Select files first.')
    result.paths = input.paths.map(workspaceGitPath)
  }
  if (input.action === 'commit') {
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 65536) throw new Error('Enter a commit message.')
    result.message = input.message
  }
  if (input.action === 'resolve') {
    result.path = workspaceGitPath(input.path!)
    if (typeof input.content !== 'string' || input.content.includes('\0') || new TextEncoder().encode(input.content).byteLength > 2 * 1024 * 1024) throw new Error('The resolved file exceeds the 2 MiB Git text editor limit.')
    result.content = input.content
  }
  if (input.action === 'abort' || input.action === 'discard') {
    if (input.confirmed !== true) throw new Error(input.action === 'abort' ? 'Confirm before aborting the Git operation.' : 'Confirm before discarding changes.')
    result.confirmed = true
  }
  return result
}
export function parseWorkspaceGitStatus(value: unknown): WorkspaceGitStatus {
  const item = value as WorkspaceGitStatus | null
  if (!item || typeof item.root !== 'string' || !(item.branch === null || typeof item.branch === 'string')
    || !(item.head === null || typeof item.head === 'string') || typeof item.revision !== 'string' || !item.revision
    || ![null, 'merge', 'rebase', 'cherry-pick', 'revert'].includes(item.operation)
    || !Number.isSafeInteger(item.staged_count) || !Number.isSafeInteger(item.conflict_count)
    || !Array.isArray(item.files) || !item.files.every(file => file && typeof file.path === 'string'
      && typeof file.index_status === 'string' && typeof file.worktree_status === 'string'
      && ['staged', 'unstaged', 'untracked', 'conflicted'].every(key => typeof file[key as keyof WorkspaceGitFile] === 'boolean'))) {
    throw new Error('The server returned an invalid Git workspace snapshot.')
  }
  return item
}
