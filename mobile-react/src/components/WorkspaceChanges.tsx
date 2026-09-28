// Workspace Changes sheet: Git status of the chat's working directory with
// stage/unstage and per-file diffs. Port of the Electron WorkspaceChanges tab.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { AlertTriangle, ArrowLeft, ChevronRight, Columns2, Folder, Minus, Plus, RefreshCw, Rows3, WrapText, X, type LucideIcon } from 'lucide-react-native'
import type { AgentServerClient } from '../api/AgentServerClient'
import { limitReviewSource, parseReviewableDiff } from '../lib/code-review'
import { buildFileTree, type FileTreeDirectory, type FileTreeNode } from '../lib/file-tree'
import { readReviewLayout, writeReviewLayout, type ReviewLayoutPreference } from '../lib/review-layout-preference'
import { fonts } from '../lib/typography'
import {
  CHANGES_FILTERS,
  countChanges,
  defaultDetailView,
  fileHasView,
  filterChanges,
  gitErrorCode,
  stageablePaths,
  unstageablePaths,
  type ChangesDetailView,
  type ChangesFilter,
} from '../lib/workspace-changes'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { WorkspaceGitConflict, WorkspaceGitDiff, WorkspaceGitFile, WorkspaceGitStatus } from '../types'
import { Text, TextInput } from './AppText'
import { connectionIsCurrent } from './CodeReview'
import { MonacoDiffView } from './MonacoDiffView'
import { IconButton, Loading, SheetCloseButton } from './ui'

// Review's threshold, reused for two decisions: whether the file list and the
// diff share the sheet side by side, and Monaco's default layout when the
// user has not chosen one. Measured on the workspace, not the window.
const SPLIT_MIN_WIDTH = 700
const gapLabel = (unchanged: number | null) => unchanged == null ? '⋯' : `⋯ ${unchanged} unchanged line${unchanged === 1 ? '' : 's'}`
const NOT_GIT_MESSAGE = "This chat's working directory is not inside a Git repository."
// A conflict side may be 2 MiB; a native Text that large stalls the UI thread.
const CONFLICT_SIDE_MAX_CHARACTERS = 64 * 1024
const FILTER_LABELS: Record<ChangesFilter, string> = { all: 'All', staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked', conflicts: 'Conflicts' }
const OPERATION_LABELS = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' } as const
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)

type Selection = { path: string; view: ChangesDetailView }
type Detail = { kind: 'diff'; value: WorkspaceGitDiff } | { kind: 'conflict'; value: WorkspaceGitConflict }

interface WorkspaceChangesProps {
  sessionId: string
  visible: boolean
  onClose: () => void
}

interface ScopedWorkspaceChangesProps extends WorkspaceChangesProps {
  connection: AgentServerClient
  connectionKey: string
  activeProfileId: string | null
  profileGeneration: number
  connectionReady: boolean
}

export function WorkspaceChanges(props: WorkspaceChangesProps) {
  const colors = usePalette()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const connection = client
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const connectionReady = connected && !connecting && !switchingProfileId && connection.isValidated
  if (!connectionReady) {
    return <Modal key={connectionKey} visible={props.visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={props.onClose}>
      <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderColor: colors.border }]}><Text style={[styles.title, { color: colors.text }]}>Changes</Text><View style={{ flex: 1 }} /><SheetCloseButton onPress={props.onClose} label="Close changes" testID="changes-unavailable-close" /></View>
        <Notice text={connecting || switchingProfileId ? 'Verifying server identity…' : 'Reconnect this server to load workspace changes.'} />
      </SafeAreaView>
    </Modal>
  }
  return <ScopedWorkspaceChanges
    key={`${connectionKey}:${props.sessionId}`}
    {...props}
    connection={connection}
    connectionKey={connectionKey}
    activeProfileId={activeProfileId}
    profileGeneration={profileGeneration}
    connectionReady={connectionReady}
  />
}

function ScopedWorkspaceChanges({ sessionId, visible, onClose, connection, connectionKey, activeProfileId, profileGeneration, connectionReady }: ScopedWorkspaceChangesProps) {
  const colors = usePalette()
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null)
  const [notGit, setNotGit] = useState(false)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<ChangesFilter>('all')
  const [query, setQuery] = useState('')
  // Directories start expanded; the set holds the exceptions.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [selection, setSelection] = useState<Selection | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [layout, setLayout] = useState<ReviewLayoutPreference>({ sideBySide: null, wordWrap: false })
  const [workspaceWidth, setWorkspaceWidth] = useState(0)
  // Bumped by every status read and every action so a slower earlier read cannot overwrite a newer result.
  const statusEpoch = useRef(0)
  const isCurrent = useCallback(() => connectionIsCurrent(connection, activeProfileId, profileGeneration), [activeProfileId, connection, profileGeneration])

  useEffect(() => {
    let cancelled = false
    void readReviewLayout().then(stored => { if (!cancelled) setLayout(stored) })
    return () => { cancelled = true }
  }, [])
  useEffect(() => () => { statusEpoch.current += 1 }, [])

  const applyStatus = useCallback((next: WorkspaceGitStatus) => {
    setStatus(next)
    setNotGit(false)
    // Keep the selected file on a side it still has (staging the viewed
    // unstaged diff moves to its staged diff); drop it once it leaves the list.
    setSelection(current => {
      if (!current) return null
      const file = next.files.find(candidate => candidate.path === current.path)
      if (!file) return null
      return fileHasView(file, current.view) ? current : { path: file.path, view: defaultDetailView(file, 'all') }
    })
  }, [])

  const refresh = useCallback(async () => {
    const epoch = ++statusEpoch.current
    setLoading(true)
    try {
      const next = await connection.workspaceGitStatus(sessionId)
      if (epoch !== statusEpoch.current || !isCurrent()) return
      applyStatus(next)
      setError(null)
    } catch (reason) {
      if (epoch !== statusEpoch.current || !isCurrent()) return
      if (gitErrorCode(reason) === 'workspace_not_git') { setNotGit(true); setStatus(null); setSelection(null) }
      else setError(errorText(reason))
    } finally {
      if (epoch === statusEpoch.current) setLoading(false)
    }
  }, [applyStatus, connection, isCurrent, sessionId])
  useEffect(() => { if (visible && connectionReady) void refresh() }, [connectionReady, refresh, visible])

  const revision = status?.revision ?? null
  useEffect(() => {
    if (!visible || !selection || !revision) return
    let cancelled = false
    setDetail(null); setDetailError(null); setDetailLoading(true)
    const request: Promise<Detail> = selection.view === 'conflict'
      ? connection.workspaceGitConflict(sessionId, selection.path).then(value => ({ kind: 'conflict' as const, value }))
      : connection.workspaceGitDiff(sessionId, selection.path, selection.view).then(value => ({ kind: 'diff' as const, value }))
    request
      .then(next => { if (!cancelled && isCurrent()) setDetail(next) })
      .catch(reason => { if (!cancelled && isCurrent()) setDetailError(errorText(reason)) })
      .finally(() => { if (!cancelled && isCurrent()) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [connection, isCurrent, revision, selection, sessionId, visible])

  const run = async (action: 'stage' | 'unstage', paths: string[]) => {
    if (busy || !status || !paths.length) return
    // The response is the next status; a status read still in flight must not overwrite it.
    statusEpoch.current += 1
    setBusy(true); setLoading(false); setError(null)
    try {
      const next = await connection.workspaceGitAction(sessionId, { action, paths, expected_revision: status.revision })
      if (!isCurrent()) return
      applyStatus(next)
    } catch (reason) {
      if (!isCurrent()) return
      setError(errorText(reason))
      // One read reconciles whatever the server applied before failing.
      void refresh()
    } finally {
      if (isCurrent()) setBusy(false)
    }
  }

  const allFiles = status?.files ?? []
  const counts = useMemo(() => countChanges(allFiles), [allFiles])
  const files = useMemo(() => filterChanges(allFiles, filter, query), [allFiles, filter, query])
  const tree = useMemo(() => buildFileTree(files.map(file => file.path)), [files])
  const stageable = stageablePaths(allFiles)
  const unstageable = unstageablePaths(allFiles)
  const selectedFile = selection ? allFiles.find(file => file.path === selection.path) ?? null : null
  const operation = status?.operation ?? null
  const split = workspaceWidth >= SPLIT_MIN_WIDTH
  const sideBySide = layout.sideBySide ?? split
  const blocked = busy || loading
  const chooseLayout = (value: boolean) => {
    setLayout(current => ({ ...current, sideBySide: value }))
    void writeReviewLayout({ sideBySide: value })
  }
  const toggleWordWrap = () => {
    const wordWrap = !layout.wordWrap
    setLayout(current => ({ ...current, wordWrap }))
    void writeReviewLayout({ wordWrap })
  }
  const select = (file: WorkspaceGitFile) => setSelection({ path: file.path, view: defaultDetailView(file, filter) })
  const switchView = (view: ChangesDetailView) => setSelection(current => current ? { ...current, view } : current)
  const title = status ? `Changes · ${status.branch || 'detached HEAD'}` : 'Changes'
  const subtitle = status ? `${counts.all} changed file${counts.all === 1 ? '' : 's'} · ${counts.staged} staged` : null

  return <Modal key={connectionKey} visible={visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={onClose}>
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { borderColor: colors.border }]}>
        {!split && selection ? <IconButton icon={ArrowLeft} onPress={() => setSelection(null)} label="Back to changed files" testID="changes-back" /> : null}
        <View style={styles.titleWrap}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        <IconButton icon={RefreshCw} disabled={blocked} onPress={() => void refresh()} label="Refresh changes" testID="changes-refresh" />
        <SheetCloseButton onPress={onClose} label="Close changes" testID="changes-close" />
      </View>
      {error ? <View accessibilityRole="alert" style={[styles.banner, { borderColor: colors.red, backgroundColor: colors.dangerSurface }]}>
        <AlertTriangle size={13} color={colors.red} /><Text selectable style={[styles.bannerText, { color: colors.text }]}>{error}</Text>
        <IconButton icon={X} size={15} onPress={() => setError(null)} label="Dismiss error" testID="changes-dismiss-error" />
      </View> : null}
      {operation ? <View accessibilityRole="alert" style={[styles.banner, { borderColor: colors.orange, backgroundColor: colors.amberSurface }]}>
        <AlertTriangle size={13} color={colors.orange} /><Text style={[styles.bannerText, { color: colors.text }]}>{`${OPERATION_LABELS[operation]} in progress${counts.conflicts ? ` · ${counts.conflicts} conflict${counts.conflicts === 1 ? '' : 's'}` : ''}. Continue or abort it from the terminal.`}</Text>
      </View> : null}
      {notGit ? <Notice text={NOT_GIT_MESSAGE} testID="changes-not-git" />
        : loading && !status ? <Loading label="Loading repository status" />
          : <View style={styles.workspace} onLayout={event => setWorkspaceWidth(event.nativeEvent.layout.width)}>
            {split || !selection ? <ScrollView style={[styles.files, split ? [styles.filesColumn, { borderColor: colors.border }] : null]} contentContainerStyle={styles.filesContent} keyboardShouldPersistTaps="always" refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={colors.muted} />}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.filters}>
                {CHANGES_FILTERS.filter(group => group === 'all' || group === filter || counts[group] > 0).map(group => <Pressable key={group} accessibilityRole="button" accessibilityLabel={`${FILTER_LABELS[group]}, ${counts[group]}`} accessibilityState={{ selected: filter === group }} testID={`changes-filter-${group}`} onPress={() => setFilter(group)} style={[styles.filterChip, { backgroundColor: filter === group ? colors.selected : colors.raised }]}>
                  <Text style={[styles.filterLabel, { color: colors.text }]}>{FILTER_LABELS[group]}</Text><Text style={[styles.filterCount, { color: colors.muted }]}>{counts[group]}</Text>
                </Pressable>)}
              </ScrollView>
              <TextInput value={query} onChangeText={setQuery} placeholder="Filter files" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} clearButtonMode="while-editing" accessibilityLabel="Filter changed files" testID="changes-search" style={[styles.search, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]} />
              <View style={styles.bulk}>
                <BulkButton icon={Plus} label="Stage all" disabled={blocked || !stageable.length} onPress={() => void run('stage', stageable)} testID="changes-stage-all" />
                <BulkButton icon={Minus} label="Unstage all" disabled={blocked || !unstageable.length} onPress={() => void run('unstage', unstageable)} testID="changes-unstage-all" />
              </View>
              {files.length ? <ChangesTree nodes={tree} depth={0} files={files} selectedPath={selection?.path ?? null} blocked={blocked} collapsed={collapsed} onToggle={path => setCollapsed(current => { const next = new Set(current); if (!next.delete(path)) next.add(path); return next })} onSelect={select} onStage={path => void run('stage', [path])} onUnstage={path => void run('unstage', [path])} />
                : <Text style={[styles.empty, { color: colors.muted }]}>{counts.all ? 'No changed files match.' : status ? 'The working tree is clean.' : ''}</Text>}
            </ScrollView> : null}
            {split || selection ? <View style={styles.detail}>
              {selection && selectedFile ? <View style={[styles.detailHeader, { borderColor: colors.border }]}>
                <Text style={[styles.detailPath, { color: colors.text }]} numberOfLines={1}>{selection.path}</Text>
                {fileHasView(selectedFile, 'staged') && fileHasView(selectedFile, 'unstaged') ? <View style={[styles.segmented, { borderColor: colors.border }]}>
                  {(['staged', 'unstaged'] as const).map(view => <Pressable key={view} accessibilityRole="button" accessibilityLabel={`Show ${view} changes`} accessibilityState={{ selected: selection.view === view }} testID={`changes-view-${view}`} onPress={() => switchView(view)} style={[styles.segment, { backgroundColor: selection.view === view ? colors.selected : 'transparent' }]}><Text style={[styles.segmentLabel, { color: colors.text }]}>{view === 'staged' ? 'Staged' : 'Unstaged'}</Text></Pressable>)}
                </View> : null}
                {selection.view !== 'conflict' ? <>
                  <IconButton icon={sideBySide ? Columns2 : Rows3} onPress={() => chooseLayout(!sideBySide)} label={sideBySide ? 'Side by side layout. Switch to inline' : 'Inline layout. Switch to side by side'} testID="changes-layout-toggle" />
                  <IconButton icon={WrapText} selected={layout.wordWrap} onPress={toggleWordWrap} label="Wrap long lines" testID="changes-word-wrap" />
                </> : null}
              </View> : null}
              {!selection ? <Notice text={allFiles.length ? 'Select a file to see its changes.' : ''} />
                : detailLoading ? <Loading label="Loading changes" />
                  : detailError ? <Notice text={detailError} tone="red" />
                    : detail?.kind === 'conflict' ? <ConflictView conflict={detail.value} />
                      : detail?.kind === 'diff' ? <DiffDetail diff={detail.value} sideBySide={sideBySide} wordWrap={layout.wordWrap} />
                        : null}
            </View> : null}
          </View>}
    </SafeAreaView>
  </Modal>
}

function ChangesTree({ nodes, depth, files, selectedPath, blocked, collapsed, onToggle, onSelect, onStage, onUnstage }: {
  nodes: FileTreeNode[]
  depth: number
  files: WorkspaceGitFile[]
  selectedPath: string | null
  blocked: boolean
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onSelect: (file: WorkspaceGitFile) => void
  onStage: (path: string) => void
  onUnstage: (path: string) => void
}) {
  const colors = usePalette()
  return <>
    {nodes.map(node => {
      if (node.kind === 'file') return <ChangesFileRow key={node.path} file={files[node.index]} name={node.name} depth={depth} selected={node.path === selectedPath} blocked={blocked} onSelect={onSelect} onStage={onStage} onUnstage={onUnstage} />
      const expanded = !collapsed.has(node.path)
      const count = fileCount(node)
      return <Fragment key={node.path}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${node.path}, ${count} file${count === 1 ? '' : 's'}`} accessibilityState={{ expanded }} onPress={() => onToggle(node.path)} style={[styles.directory, { paddingLeft: treeIndent(depth) }]}>
          <ChevronRight size={12} color={colors.muted} style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }} />
          <Folder size={12} color={colors.muted} />
          <Text style={[styles.directoryName, { color: colors.muted }]} numberOfLines={1}>{node.name}</Text>
          <Text style={{ color: colors.muted, fontSize: 10 }}>{count}</Text>
        </Pressable>
        {expanded ? <ChangesTree nodes={node.children} depth={depth + 1} files={files} selectedPath={selectedPath} blocked={blocked} collapsed={collapsed} onToggle={onToggle} onSelect={onSelect} onStage={onStage} onUnstage={onUnstage} /> : null}
      </Fragment>
    })}
  </>
}

function ChangesFileRow({ file, name, depth, selected, blocked, onSelect, onStage, onUnstage }: {
  file: WorkspaceGitFile
  name: string
  depth: number
  selected: boolean
  blocked: boolean
  onSelect: (file: WorkspaceGitFile) => void
  onStage: (path: string) => void
  onUnstage: (path: string) => void
}) {
  const colors = usePalette()
  const code = file.conflicted ? '!' : `${file.index_status}${file.worktree_status}`
  // The row shows the leaf name; the label carries the full path and, for a rename, where it came from.
  const identity = file.original_path ? `${file.original_path} → ${file.path}` : file.path
  return <View style={[styles.file, { backgroundColor: selected ? colors.raised : 'transparent', paddingLeft: treeIndent(depth) }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${identity}, ${file.conflicted ? 'conflicted' : code.trim()}`} accessibilityState={{ selected }} onPress={() => onSelect(file)} style={styles.fileName}>
      {file.conflicted ? <AlertTriangle size={11} color={colors.orange} /> : null}
      <Text style={[styles.fileLabel, { color: colors.text }]} numberOfLines={2}>{name}</Text>
      <Text style={[styles.fileCode, { color: file.conflicted ? colors.orange : colors.muted }]}>{code}</Text>
    </Pressable>
    {fileHasView(file, 'unstaged') ? <IconButton icon={Plus} size={15} disabled={blocked} onPress={() => onStage(file.path)} label={`Stage ${identity}`} /> : null}
    {fileHasView(file, 'staged') ? <IconButton icon={Minus} size={15} disabled={blocked} onPress={() => onUnstage(file.path)} label={`Unstage ${identity}`} /> : null}
  </View>
}

function BulkButton({ icon: Icon, label, disabled, onPress, testID }: { icon: LucideIcon; label: string; disabled: boolean; onPress: () => void; testID: string }) {
  const colors = usePalette()
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} testID={testID} style={({ pressed }) => [styles.bulkButton, { backgroundColor: colors.raised, opacity: disabled ? 0.4 : pressed ? 0.65 : 1 }]}>
    <Icon size={13} color={colors.muted} /><Text style={[styles.bulkLabel, { color: colors.text }]}>{label}</Text>
  </Pressable>
}

function DiffDetail({ diff, sideBySide, wordWrap }: { diff: WorkspaceGitDiff; sideBySide: boolean; wordWrap: boolean }) {
  const colors = usePalette()
  // The server diffs without rename detection, so a rename arrives as two
  // file blocks; the selected path's block wins, else the first.
  const { file, truncated } = useMemo(() => {
    const limited = limitReviewSource(diff.diff)
    const files = parseReviewableDiff(limited.source)
    return { file: files.find(candidate => candidate.path === diff.path) ?? files[0] ?? null, truncated: diff.truncated || limited.truncated }
  }, [diff])
  if (diff.binary) return <Notice text="Binary file: no text diff to show." />
  if (!file) return <Notice text="No diff to show for this view." />
  return <View style={styles.diff}>
    {truncated ? <View accessibilityRole="alert" style={[styles.inlineWarning, { borderColor: colors.orange, backgroundColor: `${colors.orange}12` }]}><AlertTriangle size={13} color={colors.orange} /><Text style={{ flex: 1, color: colors.orange, fontSize: 10.5 }}>This diff is large, so mobile is showing a bounded preview. Inspect the complete diff on desktop.</Text></View> : null}
    <MonacoDiffView file={file} path={diff.path} sideBySide={sideBySide} wordWrap={wordWrap} gapLabel={gapLabel} />
  </View>
}

// Read-only: resolving belongs to the desktop editor or the terminal.
function ConflictView({ conflict }: { conflict: WorkspaceGitConflict }) {
  const colors = usePalette()
  const sides: Array<[string, string | null]> = [['Base', conflict.base], ['Current (ours)', conflict.ours], ['Incoming (theirs)', conflict.theirs], ['Working tree result', conflict.result]]
  return <ScrollView style={styles.diff} contentContainerStyle={styles.conflictContent} testID="changes-conflict-view">
    <View accessibilityRole="alert" style={[styles.banner, styles.conflictBanner, { borderColor: colors.orange, backgroundColor: colors.amberSurface }]}>
      <AlertTriangle size={13} color={colors.orange} /><Text style={[styles.bannerText, { color: colors.text }]}>{conflict.binary ? 'Binary conflict. Resolve it in the terminal.' : 'Unresolved conflict, shown read-only. Resolve it on desktop or in the terminal.'}</Text>
    </View>
    {conflict.binary ? null : sides.map(([heading, body]) => <View key={heading} style={styles.conflictSide}>
      <Text style={[styles.conflictTitle, { color: colors.muted }]}>{heading}</Text>
      <Text selectable style={[styles.conflictBody, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}>{body == null ? '(no content on this side)' : body.length > CONFLICT_SIDE_MAX_CHARACTERS ? `${body.slice(0, CONFLICT_SIDE_MAX_CHARACTERS)}\n… truncated for mobile` : body}</Text>
    </View>)}
  </ScrollView>
}

function Notice({ text, tone = 'muted', testID }: { text: string; tone?: 'muted' | 'red'; testID?: string }) {
  const colors = usePalette()
  return <View style={styles.unavailable} testID={testID}><Text selectable style={[styles.unavailableText, { color: tone === 'red' ? colors.red : colors.muted }]}>{text}</Text></View>
}

function fileCount(node: FileTreeDirectory): number {
  return node.children.reduce((sum, child) => sum + (child.kind === 'file' ? 1 : fileCount(child)), 0)
}

const treeIndent = (depth: number) => 9 + depth * 12

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleWrap: { flex: 1, minWidth: 0 }, title: { fontSize: 15, fontWeight: '800' }, subtitle: { fontSize: 10.5, marginTop: 2 },
  banner: { marginHorizontal: 12, marginTop: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, paddingLeft: 10, paddingRight: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  bannerText: { flex: 1, fontSize: 11.5, lineHeight: 16, paddingVertical: 8 },
  unavailable: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 }, unavailableText: { maxWidth: 360, textAlign: 'center', fontSize: 12, lineHeight: 18 },
  workspace: { flex: 1, flexDirection: 'row' },
  files: { flex: 1 }, filesColumn: { flex: 0, width: 300, maxWidth: '40%', borderRightWidth: StyleSheet.hairlineWidth }, filesContent: { padding: 6, gap: 6 },
  filters: { gap: 6, paddingHorizontal: 3, paddingVertical: 2 },
  filterChip: { minHeight: 44, borderRadius: 8, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 }, filterLabel: { fontSize: 12, fontWeight: '700' }, filterCount: { fontSize: 11 },
  search: { minHeight: 44, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, fontSize: 13 },
  bulk: { flexDirection: 'row', gap: 6 }, bulkButton: { flex: 1, minHeight: 44, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 }, bulkLabel: { fontSize: 12, fontWeight: '700' },
  directory: { minHeight: 44, borderRadius: 5, paddingHorizontal: 9, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 5 }, directoryName: { flex: 1, minWidth: 0, fontSize: 11, fontFamily: fonts.mono },
  file: { minHeight: 54, borderRadius: 5, paddingRight: 2, flexDirection: 'row', alignItems: 'center' },
  fileName: { flex: 1, minWidth: 0, minHeight: 54, paddingVertical: 7, paddingRight: 6, flexDirection: 'row', alignItems: 'center', gap: 5 }, fileLabel: { flex: 1, minWidth: 0, fontSize: 11, fontFamily: fonts.mono }, fileCode: { fontSize: 10, fontFamily: fonts.mono, fontWeight: '700' },
  empty: { padding: 12, fontSize: 12 },
  detail: { flex: 1, minWidth: 0 },
  detailHeader: { minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, paddingLeft: 12, paddingRight: 4, flexDirection: 'row', alignItems: 'center', gap: 6 }, detailPath: { flex: 1, minWidth: 0, fontSize: 11, fontFamily: fonts.mono },
  segmented: { flexDirection: 'row', borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, overflow: 'hidden' }, segment: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' }, segmentLabel: { fontSize: 11, fontWeight: '700' },
  diff: { flex: 1, minHeight: 0 },
  inlineWarning: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 9, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 6 },
  conflictContent: { padding: 12, gap: 12 }, conflictBanner: { marginHorizontal: 0, marginTop: 0 }, conflictSide: { gap: 4 },
  conflictTitle: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  conflictBody: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, padding: 10, fontFamily: fonts.mono, fontSize: 11, lineHeight: 16 },
})
