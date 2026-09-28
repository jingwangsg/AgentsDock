// Pure grouping and error-classification rules for the workspace Changes
// sheet, kept out of the component so they run under node.
import type { WorkspaceGitAction, WorkspaceGitFile } from '../types'

export type ChangesFilter = 'all' | 'staged' | 'unstaged' | 'untracked' | 'conflicts'
export const CHANGES_FILTERS: readonly ChangesFilter[] = ['all', 'staged', 'unstaged', 'untracked', 'conflicts']
/** What the detail pane shows for a file; a conflicted file has no plain diff view. */
export type ChangesDetailView = 'staged' | 'unstaged' | 'conflict'

/** Same grouping as the desktop Changes tab: conflicted files appear only under Conflicts, untracked ones only under Untracked. */
export function changesFilterMatches(file: WorkspaceGitFile, filter: ChangesFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'conflicts': return file.conflicted
    case 'staged': return file.staged && !file.conflicted
    case 'unstaged': return file.unstaged && !file.conflicted && !file.untracked
    case 'untracked': return file.untracked
  }
}

export function countChanges(files: readonly WorkspaceGitFile[]): Record<ChangesFilter, number> {
  const counts: Record<ChangesFilter, number> = { all: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
  for (const file of files) for (const filter of CHANGES_FILTERS) if (changesFilterMatches(file, filter)) counts[filter] += 1
  return counts
}

/** Group filter plus a case-insensitive substring match on the repository path; input order is preserved. */
export function filterChanges(files: readonly WorkspaceGitFile[], filter: ChangesFilter, query: string): WorkspaceGitFile[] {
  const needle = query.trim().toLocaleLowerCase()
  return files.filter(file => changesFilterMatches(file, filter) && file.path.toLocaleLowerCase().includes(needle))
}

export function fileHasView(file: WorkspaceGitFile, view: ChangesDetailView): boolean {
  if (view === 'conflict') return file.conflicted
  if (view === 'staged') return file.staged && !file.conflicted
  return (file.unstaged || file.untracked) && !file.conflicted
}

/** The view a tap opens: the active group when it is Staged, otherwise the only side the file has, defaulting to the working tree. */
export function defaultDetailView(file: WorkspaceGitFile, filter: ChangesFilter): ChangesDetailView {
  if (file.conflicted) return 'conflict'
  if (filter === 'staged' || !fileHasView(file, 'unstaged')) return 'staged'
  return 'unstaged'
}

export function stageablePaths(files: readonly WorkspaceGitFile[]): string[] {
  return files.filter(file => fileHasView(file, 'unstaged')).map(file => file.path)
}

export function unstageablePaths(files: readonly WorkspaceGitFile[]): string[] {
  return files.filter(file => fileHasView(file, 'staged')).map(file => file.path)
}

/** The server's `detail.code` from a failed request, read structurally so callers need not import the client's error class. */
export function gitErrorCode(error: unknown): string | null {
  const detail = (error as { detail?: { code?: unknown } } | null)?.detail
  return detail && typeof detail.code === 'string' ? detail.code : null
}

/**
 * A 409 `git_stale_revision` means only that the status we decided on has
 * moved; a stage or unstage is safe to repeat against the fresh revision.
 * Every other action depends on what the user reviewed, so it surfaces instead.
 */
export function retriesStaleGitAction(action: WorkspaceGitAction['action'], error: unknown): boolean {
  return (action === 'stage' || action === 'unstage')
    && (error as { status?: unknown } | null)?.status === 409
    && gitErrorCode(error) === 'git_stale_revision'
}
