import type { languages } from 'monaco-editor/editor/editor.api'
import type { DiffConflictMarker, DiffConflictSide, DiffFile } from './timeline'

export interface MonacoDiffModel {
  original: string
  modified: string
  // Index = editor line - 1. null marks a placeholder row with no file line behind it.
  originalLineNumbers: Array<number | null>
  modifiedLineNumbers: Array<number | null>
  // Modified-side editor lines inside a merge conflict. The parser only marks
  // rows that exist in the resulting file, so the original side never has any.
  conflicts: Array<{ line: number; side: DiffConflictSide; marker?: DiffConflictMarker }>
}

/**
 * Rebuilds the two documents a diff editor needs from a unified diff: the
 * original side keeps context + removed rows, the modified side context +
 * added rows. Consecutive hunks are separated by one identical placeholder
 * row on both sides so the editor's own diff keeps them aligned.
 * `gapLabel` receives the number of unchanged lines skipped, or null when the
 * hunk headers carry no line numbers.
 * Returns null when the file has no content rows (binary or mode-only diffs).
 */
export function buildMonacoDiffModel(file: DiffFile, gapLabel: (unchanged: number | null) => string): MonacoDiffModel | null {
  const original: string[] = []
  const modified: string[] = []
  const originalLineNumbers: Array<number | null> = []
  const modifiedLineNumbers: Array<number | null> = []
  const conflicts: MonacoDiffModel['conflicts'] = []
  let sawHunk = false
  // One past the last old line the previous hunk covered; null when unknown.
  let previousOldEnd: number | null = null
  for (const line of file.lines) {
    if (line.kind === 'hunk') {
      // A zero-length old range names the line *before* the insertion, so the
      // first untouched line after it is oldStart + 1.
      const start = line.oldStart == null ? null : line.oldStart + (line.oldCount === 0 ? 1 : 0)
      if (sawHunk) {
        const gap = start != null && previousOldEnd != null ? start - previousOldEnd : null
        const label = gapLabel(gap != null && gap > 0 ? gap : null)
        original.push(label); originalLineNumbers.push(null)
        modified.push(label); modifiedLineNumbers.push(null)
      }
      sawHunk = true
      previousOldEnd = start == null ? null : start + (line.oldCount ?? 1)
      continue
    }
    if (line.kind === 'header') continue
    // CRLF diffs keep the \r on every row; left in place Monaco would split the
    // row and shift every gutter number after it.
    const text = line.text.replace(/\r$/, '')
    if (line.kind !== 'add') {
      original.push(text)
      originalLineNumbers.push(line.oldLine ?? null)
    }
    if (line.kind !== 'remove') {
      modified.push(text)
      modifiedLineNumbers.push(line.newLine ?? null)
      if (line.conflictSide) conflicts.push({ line: modified.length, side: line.conflictSide, marker: line.conflictMarker })
    }
  }
  if (original.length === 0 && modified.length === 0) return null
  return { original: original.join('\n'), modified: modified.join('\n'), originalLineNumbers, modifiedLineNumbers, conflicts }
}

/** Picks a Monaco language id for `path`; exact filenames win over extensions, longer extensions over shorter ones. */
export function languageIdForPath(path: string, registered: ReadonlyArray<Pick<languages.ILanguageExtensionPoint, 'id' | 'extensions' | 'filenames'>>): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  let best = 'plaintext'
  let bestLength = 0
  for (const language of registered) {
    if (language.filenames?.some(candidate => candidate.toLowerCase() === name)) return language.id
    for (const extension of language.extensions ?? []) {
      if (extension.length > bestLength && name.endsWith(extension.toLowerCase())) {
        best = language.id
        bestLength = extension.length
      }
    }
  }
  return best
}
