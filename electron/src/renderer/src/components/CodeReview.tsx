// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, ChevronRight, Columns2, Copy, FileCode2, FileDiff, Folder, LoaderCircle, RotateCcw, Rows3, Search, TextWrap, X } from 'lucide-react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { buildFileTree, type FileTreeDirectory, type FileTreeNode } from '@shared/file-tree'
import type { CodeReviewTarget, DiffFile, DiffLine } from '../lib/timeline'
import { parseReviewableDiff } from '../lib/timeline'
import { buildMonacoDiffModel } from '../lib/monaco-diff-model'
import { useTransientClose } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { MonacoDiffEditor } from './MonacoDiffEditor'

type ReviewRow =
  | { kind: 'file'; file: DiffFile; fileIndex: number }
  | { kind: 'gap'; count: number; fileIndex: number }
  | { kind: 'line'; line: DiffLine; fileIndex: number }

interface ReviewModel {
  rows: ReviewRow[]
  fileStarts: number[]
}

interface ReviewFileEntry {
  file: DiffFile
  fileIndex: number
}

const SIDE_BY_SIDE_KEY = 'agentsdock:review-side-by-side'
const WORD_WRAP_KEY = 'agentsdock:review-word-wrap'

export function CodeReview({ target, onClose }: { target: CodeReviewTarget | null; onClose: () => void }) {
  const locale = useLocale()
  useTransientClose(Boolean(target), onClose)
  const [source, setSource] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [activeFile, setActiveFile] = useState(0)
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<'tree' | 'flat'>('tree')
  const [sideBySide, setSideBySide] = useState(() => localStorage.getItem(SIDE_BY_SIDE_KEY) !== '0')
  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem(WORD_WRAP_KEY) === '1')
  // Set when Monaco fails to load; the pane then keeps the line-based renderer for this mount.
  const [editorFailure, setEditorFailure] = useState<string | null>(null)
  // Directories start expanded; the set holds the exceptions for the current target.
  const [collapsedDirectories, setCollapsedDirectories] = useState<ReadonlySet<string>>(new Set())
  const list = useRef<VirtuosoHandle>(null)
  const requestEpoch = useRef(0)

  useEffect(() => {
    const epoch = ++requestEpoch.current
    setSource(target?.source ?? '')
    setError(null)
    setCopied(false)
    setActiveFile(0)
    setFilter('')
    setCollapsedDirectories(new Set())
    if (!target?.runId) {
      setLoading(false)
      return
    }
    setLoading(true)
    void window.agentsDock.diffs.get(target.sessionId, target.runId)
      .then(diff => { if (requestEpoch.current === epoch) setSource(diff) })
      .catch(reason => {
        if (requestEpoch.current !== epoch) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (requestEpoch.current === epoch) setLoading(false) })
    return () => { if (requestEpoch.current === epoch) requestEpoch.current += 1 }
  }, [target])

  const files = useMemo(() => parseReviewableDiff(source), [source])
  const model = useMemo(() => buildReviewModel(files), [files])
  const parsedAdditions = files.reduce((sum, file) => sum + file.additions, 0)
  const parsedDeletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const additions = target?.runId && target.additions != null ? target.additions : parsedAdditions
  const deletions = target?.runId && target.deletions != null ? target.deletions : parsedDeletions
  const fileCount = files.length || (loading ? target?.files?.length ?? 0 : 0)
  const conflictedFiles = files.filter(file => file.conflictCount > 0)
  const conflictCount = conflictedFiles.reduce((sum, file) => sum + file.conflictCount, 0)
  const normalizedFilter = filter.trim().toLowerCase()
  const filteredEntries = useMemo(() => files.map((file, fileIndex) => ({ file, fileIndex }))
    .filter(entry => !normalizedFilter || entry.file.path.toLowerCase().includes(normalizedFilter)), [files, normalizedFilter])
  // Tree file nodes index into filteredEntries, which maps back to the real fileIndex.
  const fileTree = useMemo(() => buildFileTree(filteredEntries.map(entry => entry.file.path)), [filteredEntries])
  const activeEntry: DiffFile | undefined = files[Math.min(activeFile, files.length - 1)]
  // The placeholder text is baked into the documents, so the model also follows the locale.
  const editorModel = useMemo(() => activeEntry
    ? buildMonacoDiffModel(activeEntry, unchanged => unchanged == null
      ? '⋯'
      : `⋯ ${t(unchanged === 1 ? 'review.unmodifiedLines.one' : 'review.unmodifiedLines.other', { count: unchanged.toLocaleString() })}`)
    : null, [activeEntry, locale])
  const unavailableMessage = error || (source.trim() && files.length === 0
    ? t('review.inventoryOnly')
    : t('review.noChanges'))

  if (!target) return null

  const retry = () => {
    if (!target.runId) return
    const epoch = ++requestEpoch.current
    const { sessionId, runId } = target
    setLoading(true)
    setError(null)
    void window.agentsDock.diffs.get(sessionId, runId)
      .then(diff => { if (requestEpoch.current === epoch) setSource(diff) })
      .catch(reason => { if (requestEpoch.current === epoch) setError(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (requestEpoch.current === epoch) setLoading(false) })
  }
  const copy = async () => {
    try {
      await window.agentsDock.native.writeClipboard(source)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch (reason) {
      useAppStore.getState().setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  const jumpToFile = (fileIndex: number) => {
    setActiveFile(fileIndex)
    list.current?.scrollToIndex({ index: model.fileStarts[fileIndex] ?? 0, align: 'start', behavior: 'auto' })
  }
  const toggleDirectory = (path: string) => setCollapsedDirectories(current => {
    const next = new Set(current)
    if (!next.delete(path)) next.add(path)
    return next
  })
  const chooseLayout = (value: boolean) => {
    setSideBySide(value)
    localStorage.setItem(SIDE_BY_SIDE_KEY, value ? '1' : '0')
  }
  const toggleWordWrap = () => {
    setWordWrap(!wordWrap)
    localStorage.setItem(WORD_WRAP_KEY, wordWrap ? '0' : '1')
  }

  return <section className="review-panel" role="region" aria-label={t("ui.CodeReview.CodeReview.code_review_3d20067")}>
    <p className="sr-only">{t("ui.CodeReview.CodeReview.complete_code_changes_from_the_selected_ag_4d526c7")}</p>
    <header className="review-header">
      <h2><FileDiff size={15} />{" "}{t("ui.CodeReview.CodeReview.review_aff0766")}</h2>
      <span className="review-spacer" />
      {!editorFailure && <>
        <div className="segmented review-layout-toggle">
          <button type="button" className={sideBySide ? 'active' : ''} aria-pressed={sideBySide} onClick={() => chooseLayout(true)}><Columns2 size={13} aria-hidden="true" />{t('review.layoutSideBySide')}</button>
          <button type="button" className={sideBySide ? '' : 'active'} aria-pressed={!sideBySide} onClick={() => chooseLayout(false)}><Rows3 size={13} aria-hidden="true" />{t('review.layoutInline')}</button>
        </div>
        <div className="segmented review-layout-toggle">
          <button type="button" className={wordWrap ? 'active' : ''} aria-pressed={wordWrap} onClick={toggleWordWrap}><TextWrap size={13} aria-hidden="true" />{t('review.wordWrap')}</button>
        </div>
      </>}
      <button type="button" className="quiet-button" disabled={files.length === 0} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{" "}{t("ui.CodeReview.CodeReview.copy_diff_6e0cb31")}</button>
      <button type="button" className="icon-button" aria-label={t("ui.CodeReview.CodeReview.close_review_337f911")} onClick={onClose}><X size={16} /></button>
    </header>
    <div className="review-toolbar">
      <span className="review-turn-selector"><strong>{t("ui.CodeReview.CodeReview.last_turn_6e9abd8")}</strong><ChevronDown size={13} /></span>
      <span className="diff-stat"><b>+{additions}</b><i>-{deletions}</i></span>
      <span>{t(fileCount === 1 ? 'review.fileCount.one' : 'review.fileCount.other', { count: fileCount })}</span>
      {conflictCount > 0 && <span className="review-conflict-summary" role="status">
        <AlertTriangle size={12} aria-hidden="true" />
        {t(conflictedFiles.length === 1 ? 'review.conflictedFiles.one' : 'review.conflictedFiles.other', { count: conflictedFiles.length })} · {reviewConflictCount(conflictCount)}
      </span>}
      {files.length > 0 && <select className="review-file-select" aria-label={t("ui.CodeReview.CodeReview.jump_to_changed_file_88d0435")} value={Math.min(activeFile, files.length - 1)} onChange={event => jumpToFile(Number(event.target.value))}>
        {files.map((file, index) => <option value={index} key={`${file.path}:${index}`}>{file.conflictCount > 0 ? t('review.fileOption', { path: file.path, conflicts: reviewConflictCount(file.conflictCount) }) : file.path}</option>)}
      </select>}
    </div>
    <div className="review-workspace">
      <section className="review-diff-view">
        {error && files.length > 0 && <div className="review-inline-warning"><span>{error}</span><button type="button" onClick={retry}><RotateCcw size={13} />{" "}{t("ui.CodeReview.CodeReview.retry_942087c")}</button></div>}
        {loading && files.length === 0 ? <div className="review-state"><LoaderCircle className="spin" size={18} /><span>{t("ui.CodeReview.CodeReview.loading_complete_diff_73af489")}</span></div>
          : model.rows.length === 0 ? <div className="review-state error"><FileDiff size={24} /><span>{unavailableMessage}</span>{target.runId && <button type="button" className="quiet-button" onClick={retry}><RotateCcw size={14} />{" "}{t("ui.CodeReview.CodeReview.retry_942087c")}</button>}</div>
            : editorFailure || !activeEntry
              ? <div className="review-diff-fallback">
                <p className="review-fallback-note" title={editorFailure ?? undefined}>{t('review.editorUnavailable')}</p>
                <Virtuoso
                  ref={list}
                  className="review-diff-list"
                  data={model.rows}
                  computeItemKey={(index, row) => reviewRowKey(row, index)}
                  rangeChanged={range => setActiveFile(fileIndexAtRow(model.fileStarts, range.startIndex))}
                  itemContent={(_index, row) => <ReviewRowView row={row} />}
                />
              </div>
              : <div className="review-diff-file">
                <ReviewRowView row={{ kind: 'file', file: activeEntry, fileIndex: activeFile }} />
                {editorModel
                  ? <MonacoDiffEditor path={activeEntry.path} model={editorModel} sideBySide={sideBySide} wordWrap={wordWrap} onUnavailable={setEditorFailure} />
                  : <div className="review-diff-list">{activeEntry.lines.map((line, index) => <ReviewRowView key={index} row={{ kind: 'line', line, fileIndex: activeFile }} />)}</div>}
              </div>}
      </section>
      <aside className="review-navigator" aria-label={t("ui.CodeReview.CodeReview.changed_files_5d4041a")}>
        <label className="review-filter"><Search size={13} /><input value={filter} onChange={event => setFilter(event.target.value)} placeholder={t("ui.CodeReview.CodeReview.filter_files_b50efe9")} /></label>
        <div className="review-tree-root">
          <Folder size={14} /><strong title={target.repositoryRoot || undefined}>{shortRepositoryRoot(target.repositoryRoot)}</strong><span>{files.length}</span>
          <div className="segmented review-view-toggle">
            <button type="button" className={view === 'tree' ? 'active' : ''} aria-pressed={view === 'tree'} onClick={() => setView('tree')}>{t('review.viewTree')}</button>
            <button type="button" className={view === 'flat' ? 'active' : ''} aria-pressed={view === 'flat'} onClick={() => setView('flat')}>{t('review.viewFlat')}</button>
          </div>
        </div>
        <div className="review-tree">
          {filteredEntries.length === 0
            ? <p>{t("ui.CodeReview.CodeReview.no_matching_files_7eaa329")}</p>
            : view === 'tree'
              ? <ReviewTree nodes={fileTree} depth={0} entries={filteredEntries} activeFile={activeFile} collapsed={collapsedDirectories} onToggle={toggleDirectory} onSelect={jumpToFile} />
              : filteredEntries.map(entry => <ReviewFileButton key={`${entry.file.path}:${entry.fileIndex}`} entry={entry} label={entry.file.path} depth={0} active={entry.fileIndex === activeFile} onSelect={jumpToFile} />)}
        </div>
      </aside>
    </div>
  </section>
}

function ReviewTree({ nodes, depth, entries, activeFile, collapsed, onToggle, onSelect }: {
  nodes: FileTreeNode[]
  depth: number
  entries: ReviewFileEntry[]
  activeFile: number
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onSelect: (index: number) => void
}) {
  useLocale()
  return <>
    {nodes.map(node => {
      if (node.kind === 'file') {
        const entry = entries[node.index]
        return <ReviewFileButton key={`${entry.file.path}:${entry.fileIndex}`} entry={entry} label={node.name} depth={depth} active={entry.fileIndex === activeFile} onSelect={onSelect} />
      }
      const expanded = !collapsed.has(node.path)
      const stats = directoryStats(node, entries)
      const files = t(stats.count === 1 ? 'review.fileCount.one' : 'review.fileCount.other', { count: stats.count })
      return <Fragment key={node.path}>
        <button type="button" className="review-tree-directory" style={{ paddingLeft: treeIndent(depth) }} aria-expanded={expanded} aria-label={t('review.directoryAccessibleName', { path: node.path, files, additions: stats.additions, deletions: stats.deletions })} onClick={() => onToggle(node.path)}>
          <ChevronRight size={12} aria-hidden="true" /><Folder size={13} aria-hidden="true" /><span className="review-file-name">{node.name}</span><span className="review-directory-count" aria-hidden="true">{stats.count}</span><small aria-hidden="true"><b>+{stats.additions}</b><i>-{stats.deletions}</i></small>
        </button>
        {expanded && <ReviewTree nodes={node.children} depth={depth + 1} entries={entries} activeFile={activeFile} collapsed={collapsed} onToggle={onToggle} onSelect={onSelect} />}
      </Fragment>
    })}
  </>
}

function ReviewFileButton({ entry, label, depth, active, onSelect }: { entry: ReviewFileEntry; label: string; depth: number; active: boolean; onSelect: (index: number) => void }) {
  useLocale()
  const { file, fileIndex } = entry
  return <button type="button" className={active ? 'active' : ''} style={{ paddingLeft: treeIndent(depth) }} title={file.path} aria-current={active ? 'true' : undefined} aria-label={reviewFileAccessibleName(file)} onClick={() => onSelect(fileIndex)}>
    <span className="review-file-status" aria-hidden="true">M</span><FileCode2 size={13} aria-hidden="true" /><span className="review-file-name">{label}</span>{file.conflictCount > 0 && <ConflictBadge count={file.conflictCount} />}<small aria-hidden="true"><b>+{file.additions}</b><i>-{file.deletions}</i></small>
  </button>
}

const treeIndent = (depth: number) => 5 + depth * 13

function directoryStats(node: FileTreeDirectory, entries: ReviewFileEntry[]): { count: number; additions: number; deletions: number } {
  const stats = { count: 0, additions: 0, deletions: 0 }
  for (const child of node.children) {
    const part = child.kind === 'directory'
      ? directoryStats(child, entries)
      : { count: 1, additions: entries[child.index].file.additions, deletions: entries[child.index].file.deletions }
    stats.count += part.count
    stats.additions += part.additions
    stats.deletions += part.deletions
  }
  return stats
}

function shortRepositoryRoot(path?: string | null): string {
  if (!path) return t("ui.CodeReview.shortRepositoryRoot.changed_files_5d4041a")
  const parts = path.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

function buildReviewModel(files: DiffFile[]): ReviewModel {
  const rows: ReviewRow[] = []
  const fileStarts: number[] = []
  files.forEach((file, fileIndex) => {
    fileStarts.push(rows.length)
    rows.push({ kind: 'file', file, fileIndex })
    let previousOldEnd = 0
    for (const line of file.lines) {
      if (line.kind === 'hunk' && line.oldStart != null) {
        const gap = Math.max(0, line.oldStart - previousOldEnd - (previousOldEnd === 0 ? 1 : 0))
        if (gap > 0) rows.push({ kind: 'gap', count: gap, fileIndex })
        previousOldEnd = line.oldStart + (line.oldCount ?? 1)
      }
      rows.push({ kind: 'line', line, fileIndex })
    }
  })
  return { rows, fileStarts }
}

function fileIndexAtRow(starts: number[], rowIndex: number): number {
  let fileIndex = 0
  for (let index = 0; index < starts.length; index++) {
    if (starts[index] > rowIndex) break
    fileIndex = index
  }
  return fileIndex
}

function reviewRowKey(row: ReviewRow, index: number): string {
  if (row.kind === 'file') return `file:${row.fileIndex}:${row.file.path}`
  if (row.kind === 'gap') return `gap:${row.fileIndex}:${index}`
  return `line:${row.fileIndex}:${index}`
}

function ReviewRowView({ row }: { row: ReviewRow }) {
  useLocale()
  if (row.kind === 'file') {
    return <div className="diff-file-header">
      <span className="review-file-path" title={row.file.path}>{row.file.path}</span>
      {row.file.conflictCount > 0 && <ConflictBadge count={row.file.conflictCount} />}
      <small><b>+{row.file.additions}</b><i>-{row.file.deletions}</i></small>
    </div>
  }
  if (row.kind === 'gap') return <div className="diff-gap">{t(row.count === 1 ? 'review.unmodifiedLines.one' : 'review.unmodifiedLines.other', { count: row.count.toLocaleString() })}</div>
  const line = row.line
  const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : line.kind === 'context' ? ' ' : ''
  const markerLabel = line.conflictMarker ? conflictMarkerLabel(line.conflictMarker) : null
  return <div
    className={`diff-line ${line.kind}${line.conflictMarker ? ' conflict-marker' : ''}`}
    data-conflict-side={line.conflictSide}
    data-conflict-block={line.conflictBlock}
    role={line.conflictMarker ? 'separator' : undefined}
    aria-label={line.conflictMarker ? conflictMarkerAccessibleName(line) : undefined}
  >
    <span className="old-line">{line.oldLine ?? ''}</span>
    <span className="new-line">{line.newLine ?? ''}</span>
    <code>{prefix}{line.text}{markerLabel && <span className="conflict-marker-label" aria-hidden="true">{markerLabel}</span>}</code>
  </div>
}

function ConflictBadge({ count }: { count: number }) {
  useLocale()
  return <span className="review-conflict-badge"><AlertTriangle size={10} aria-hidden="true" />{count === 1 ? t("ui.CodeReview.ConflictBadge.conflict_014659a") : reviewConflictCount(count)}</span>
}

function reviewConflictCount(count: number): string {
  return t(count === 1 ? 'review.conflicts.one' : 'review.conflicts.other', { count })
}

function reviewFileAccessibleName(file: DiffFile): string {
  return t(file.conflictCount > 0 ? 'review.conflictedFileAccessibleName' : 'review.fileAccessibleName', {
    path: file.path,
    conflicts: reviewConflictCount(file.conflictCount),
    additions: file.additions,
    deletions: file.deletions
  })
}

function conflictMarkerLabel(marker: NonNullable<DiffLine['conflictMarker']>): string {
  if (marker === 'start') return t("ui.CodeReview.conflictMarkerLabel.ours_ab658c1")
  if (marker === 'base') return t("ui.CodeReview.conflictMarkerLabel.base_cbf36a9")
  if (marker === 'separator') return t("ui.CodeReview.conflictMarkerLabel.theirs_691ef72")
  return t("ui.CodeReview.conflictMarkerLabel.end_b891f9e")
}

function conflictMarkerAccessibleName(line: DiffLine): string {
  const detail = line.conflictLabel ? `, ${line.conflictLabel}` : ''
  if (line.conflictMarker === 'start') return t("ui.CodeReview.conflictMarkerAccessibleName.merge_conflict_ours_section_begins_7b943e9", { "detail": String(detail) })
  if (line.conflictMarker === 'base') return t("ui.CodeReview.conflictMarkerAccessibleName.merge_conflict_base_section_begins_ff257bb", { "detail": String(detail) })
  if (line.conflictMarker === 'separator') return t("ui.CodeReview.conflictMarkerAccessibleName.merge_conflict_theirs_section_begins_caaf549")
  return t("ui.CodeReview.conflictMarkerAccessibleName.merge_conflict_ends_e2f37ce", { "detail": String(detail) })
}
