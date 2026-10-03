import type { CodeDiffFileSummary } from '@shared/types'

export interface DiffFile {
  path: string
  additions: number
  deletions: number
  conflictCount: number
  isCombinedDiff: boolean
  lines: DiffLine[]
}

export type DiffConflictSide = 'ours' | 'base' | 'theirs'
export type DiffConflictMarker = 'start' | 'base' | 'separator' | 'end'

export interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'header' | 'hunk'
  text: string
  oldLine?: number
  newLine?: number
  oldStart?: number
  oldCount?: number
  newStart?: number
  newCount?: number
  conflictBlock?: number
  conflictSide?: DiffConflictSide
  conflictMarker?: DiffConflictMarker
  conflictLabel?: string
}

export interface CodeReviewTarget {
  sessionId: string
  runId?: string | null
  source?: string | null
  files?: CodeDiffFileSummary[] | null
  additions?: number | null
  deletions?: number | null
  repositoryRoot?: string | null
}

export function reviewTargetBelongsToSession(target: CodeReviewTarget | null, sessionId: string | null): boolean {
  return Boolean(target && sessionId && target.sessionId === sessionId)
}

export function sameCodeReviewTarget(left: CodeReviewTarget | null, right: CodeReviewTarget | null): boolean {
  if (!left || !right || left.sessionId !== right.sessionId) return false
  if (left.runId || right.runId) return Boolean(left.runId && right.runId && left.runId === right.runId)
  return Boolean(left.source && right.source && left.source === right.source)
}

export function parseUnifiedDiff(source: string): DiffFile[] {
  if (!source.trim()) return []
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of source.split('\n')) {
    const patchFile = line.match(/^\*\*\* (Update|Add|Delete) File:\s*(.+)$/i)
    if (patchFile) {
      current = { path: cleanDiffPath(patchFile[2]), additions: 0, deletions: 0, conflictCount: 0, isCombinedDiff: false, lines: [{ kind: 'header', text: line }] }
      files.push(current); oldLine = 1; newLine = 1; inHunk = false; continue
    }
    const combinedFile = line.match(/^diff --(?:cc|combined)\s+(.+)$/)
    if (combinedFile) {
      current = { path: cleanDiffPath(combinedFile[1]), additions: 0, deletions: 0, conflictCount: 0, isCombinedDiff: true, lines: [{ kind: 'header', text: line }] }
      files.push(current); inHunk = false; continue
    }
    if (line.startsWith('diff --git ')) {
      const match = line.match(/\s"?b\/(.+?)"?$/)
      current = { path: cleanDiffPath(match?.[1] ?? 'Changes'), additions: 0, deletions: 0, conflictCount: 0, isCombinedDiff: false, lines: [{ kind: 'header', text: line }] }
      files.push(current); inHunk = false; continue
    }
    if (!current) {
      if (line.startsWith('--- ')) { current = { path: cleanDiffPath(line.slice(4)), additions: 0, deletions: 0, conflictCount: 0, isCombinedDiff: false, lines: [] }; files.push(current) }
      else {
        const status = line.match(/^(?: M|M |MM|AM| A|A |\?\?| D|D | R|R )\s+(.+)$/)
        if (status) files.push({ path: cleanDiffPath(status[1]), additions: 0, deletions: 0, conflictCount: 0, isCombinedDiff: false, lines: [{ kind: 'header', text: line }] })
        continue
      }
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]); inHunk = true
      current.lines.push({
        kind: 'hunk', text: line,
        oldStart: oldLine, oldCount: Number(hunk[2] ?? 1),
        newStart: newLine, newCount: Number(hunk[4] ?? 1)
      })
      continue
    }
    if (line.startsWith('@@')) {
      inHunk = true
      current.lines.push({ kind: 'hunk', text: line })
      continue
    }
    if (!inHunk) {
      current.lines.push({ kind: 'header', text: line })
      if (line.startsWith('+++ ') && current.path === '/dev/null') current.path = cleanDiffPath(line.slice(4))
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions++; current.lines.push({ kind: 'add', text: line.slice(1), newLine: newLine++ }); continue
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions++; current.lines.push({ kind: 'remove', text: line.slice(1), oldLine: oldLine++ }); continue
    }
    if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ }); continue
    }
    current.lines.push({ kind: 'header', text: line })
  }
  files.forEach(annotateDiffConflicts)
  return files
}

interface DiffConflictBoundary {
  marker: DiffConflictMarker
  width: number
  label?: string
}

function diffConflictBoundary(text: string): DiffConflictBoundary | null {
  const normalized = text.endsWith('\r') ? text.slice(0, -1) : text
  const start = normalized.match(/^(<{7,})(?:[\t ]+(.+))?$/)
  if (start) return { marker: 'start', width: start[1].length, label: start[2]?.trim() || undefined }
  const base = normalized.match(/^(\|{7,})(?:[\t ]+(.+))?$/)
  if (base) return { marker: 'base', width: base[1].length, label: base[2]?.trim() || undefined }
  const separator = normalized.match(/^(={7,})[\t ]*$/)
  if (separator) return { marker: 'separator', width: separator[1].length }
  const end = normalized.match(/^(>{7,})(?:[\t ]+(.+))?$/)
  if (end) return { marker: 'end', width: end[1].length, label: end[2]?.trim() || undefined }
  return null
}

function annotateDiffConflicts(file: DiffFile): void {
  if (file.isCombinedDiff) return
  type PendingConflictLine = {
    line: DiffLine
    side: DiffConflictSide
    boundary: DiffConflictBoundary | null
  }
  let candidate: {
    width: number
    side: DiffConflictSide
    phase: 'ours' | 'base' | 'theirs'
    lines: PendingConflictLine[]
  } | null = null
  for (const line of file.lines) {
    // Only rows present in the resulting file participate. Removed old-side
    // markers and metadata cannot create, advance, or receive conflict UI.
    if (line.kind !== 'add' && line.kind !== 'context') continue
    const boundary = diffConflictBoundary(line.text)
    if (!candidate) {
      if (boundary?.marker === 'start') {
        candidate = { width: boundary.width, side: 'ours', phase: 'ours', lines: [{ line, side: 'ours', boundary }] }
      }
      continue
    }

    let validBoundary = true
    if (boundary) {
      validBoundary = boundary.width === candidate.width
      if (validBoundary && boundary.marker === 'base') {
        validBoundary = candidate.phase === 'ours'
        if (validBoundary) candidate.phase = candidate.side = 'base'
      } else if (validBoundary && boundary.marker === 'separator') {
        validBoundary = candidate.phase === 'ours' || candidate.phase === 'base'
        if (validBoundary) candidate.phase = candidate.side = 'theirs'
      } else if (validBoundary && boundary.marker === 'end') {
        validBoundary = candidate.phase === 'theirs'
      } else if (boundary.marker === 'start') {
        validBoundary = false
      }
    }
    if (!validBoundary) {
      candidate = null
      continue
    }

    candidate.lines.push({ line, side: candidate.side, boundary })
    if (boundary?.marker !== 'end') continue

    const block = file.conflictCount + 1
    for (const pending of candidate.lines) {
      pending.line.conflictBlock = block
      pending.line.conflictSide = pending.side
      if (pending.boundary) {
        pending.line.conflictMarker = pending.boundary.marker
        pending.line.conflictLabel = pending.boundary.label
      }
    }
    file.conflictCount = block
    candidate = null
  }
}

export function parseReviewableDiff(source: string): DiffFile[] {
  return parseUnifiedDiff(source).filter(file => file.lines.some(line =>
    line.kind === 'hunk' || line.kind === 'add' || line.kind === 'remove' ||
    (line.kind === 'header' && (/^diff --git /.test(line.text) || /^\*\*\* (?:Update|Add|Delete) File:/.test(line.text) || /^Binary files /.test(line.text) || /^(?:old|new) mode \d+/.test(line.text)))
  ))
}

function cleanDiffPath(value: string): string { return value.trim().replace(/^[ab]\//, '').replace(/^["'`]|["'`]$/g, '') }
