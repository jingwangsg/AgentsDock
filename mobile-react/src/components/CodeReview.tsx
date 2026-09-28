import { Fragment, useEffect, useMemo, useState } from 'react'
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import { AlertTriangle, ChevronRight, Copy, Folder } from 'lucide-react-native'
import type { AgentServerClient } from '../api/AgentServerClient'
import {
  codeReviewFallback,
  limitReviewSource,
  type DiffFile,
  type DiffLine,
  parseReviewableDiff,
} from '../lib/code-review'
import { buildFileTree, type FileTreeDirectory, type FileTreeNode } from '../lib/file-tree'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { fonts } from '../lib/typography'
import { Text } from './AppText'
import { IconButton, Loading, SheetCloseButton } from './ui'

interface CodeReviewProps {
  sessionId: string
  runId: string | null
  onClose: () => void
}

interface ScopedCodeReviewProps extends CodeReviewProps {
  connection: AgentServerClient
  connectionKey: string
  activeProfileId: string | null
  profileGeneration: number
  connectionReady: boolean
}

export function CodeReview(props: CodeReviewProps) {
  const colors = usePalette()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const connection = client
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const connectionReady = connected && !connecting && !switchingProfileId && connection.isValidated
  const hasLocalFallback = Boolean(props.runId && codeReviewFallback(profileGeneration, props.sessionId, props.runId)?.source.trim())
  if (props.runId && !connectionReady && !hasLocalFallback) {
    return <Modal key={connectionKey} visible animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={props.onClose}>
      <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderColor: colors.border }]}><Text style={[styles.title, { color: colors.text }]}>Review</Text><View style={{ flex: 1 }} /><SheetCloseButton onPress={props.onClose} label="Close review" testID="review-unavailable-close" /></View>
        <View style={styles.unavailable}><Text style={[styles.unavailableText, { color: colors.muted }]}>{connecting || switchingProfileId ? 'Verifying server identity…' : 'Reconnect this server to load the review.'}</Text></View>
      </SafeAreaView>
    </Modal>
  }
  return <ScopedCodeReview
    key={`${connectionKey}:${props.sessionId}:${props.runId ?? 'none'}`}
    {...props}
    connection={connection}
    connectionKey={connectionKey}
    activeProfileId={activeProfileId}
    profileGeneration={profileGeneration}
    connectionReady={connectionReady}
  />
}

function ScopedCodeReview({ sessionId, runId, onClose, connection, connectionKey, activeProfileId, profileGeneration, connectionReady }: ScopedCodeReviewProps) {
  const colors = usePalette()
  const fallback = useMemo(() => runId ? codeReviewFallback(profileGeneration, sessionId, runId) : null, [profileGeneration, runId, sessionId])
  const [diff, setDiff] = useState(fallback?.source ?? '')
  const [truncated, setTruncated] = useState(Boolean(fallback?.truncated))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState(0)
  // Directories start expanded; the set holds the exceptions for the current review.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    let cancelled = false
    const localFallback = runId ? codeReviewFallback(profileGeneration, sessionId, runId) : null
    setDiff(localFallback?.source ?? '')
    setTruncated(Boolean(localFallback?.truncated))
    setSelected(0)
    setCollapsed(new Set())
    setError(null)
    setLoading(Boolean(runId && connectionReady))
    if (!runId || !connectionReady) return () => { cancelled = true }
    void connection.codeDiff(sessionId, runId)
      .then(value => {
        if (cancelled || !connectionIsCurrent(connection, activeProfileId, profileGeneration)) return
        const limited = limitReviewSource(value.text)
        if (limited.source.trim() && parseReviewableDiff(limited.source).length) {
          setDiff(limited.source)
          setTruncated(value.truncated || limited.truncated)
        } else {
          setTruncated(Boolean(localFallback?.truncated) || value.truncated || limited.truncated)
          if (!localFallback?.source.trim()) setError('No line-level code changes were captured for this turn.')
          else if (limited.source.trim()) setError('The server returned no reviewable patch. Showing the locally captured patch.')
        }
      })
      .catch(reason => {
        if (cancelled || !connectionIsCurrent(connection, activeProfileId, profileGeneration)) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!cancelled && connectionIsCurrent(connection, activeProfileId, profileGeneration)) setLoading(false)
      })
    return () => { cancelled = true }
  }, [activeProfileId, connection, connectionReady, profileGeneration, runId, sessionId])
  const files = useMemo(() => parseReviewableDiff(diff), [diff])
  const tree = useMemo(() => buildFileTree(files.map(file => file.path)), [files])
  const file = files[Math.min(selected, Math.max(0, files.length - 1))]
  const additions = files.reduce((sum, value) => sum + value.additions, 0)
  const deletions = files.reduce((sum, value) => sum + value.deletions, 0)
  const conflictCount = files.reduce((sum, value) => sum + value.conflictCount, 0)
  const sizeWarning = truncated ? 'This review is large, so mobile is showing a bounded preview. Copy or inspect the complete diff on desktop.' : null
  const errorWarning = error
    ? `${error}${fallback?.source.trim() && !error.includes('Showing the locally captured patch.') ? ' Showing the locally captured patch.' : ''}`
    : null
  const unavailable = error || sizeWarning || 'No line-level code changes were captured for this turn.'
  return <Modal key={connectionKey} visible={Boolean(runId)} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={onClose}>
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.text }]}>Review</Text>
        <Text style={{ color: colors.green }}>+{additions}</Text>
        <Text style={{ color: colors.red }}>-{deletions}</Text>
        {conflictCount ? <View accessibilityRole="alert" style={[styles.conflictSummary, { backgroundColor: `${colors.orange}18` }]}><AlertTriangle size={12} color={colors.orange} /><Text style={{ color: colors.orange, fontSize: 10, fontWeight: '800' }}>{conflictCount} conflict{conflictCount === 1 ? '' : 's'}</Text></View> : null}
        <View style={{ flex: 1 }} />
        <IconButton icon={Copy} onPress={() => void Clipboard.setStringAsync(diff)} label="Copy diff" />
        <SheetCloseButton onPress={onClose} label="Close review" testID="review-close" />
      </View>
      {loading && !files.length ? <Loading label="Loading complete diff" /> : !files.length ? <View style={styles.unavailable}><AlertTriangle size={20} color={colors.orange} /><Text selectable style={[styles.unavailableText, { color: colors.muted }]}>{unavailable}</Text></View> : <View style={styles.workspace}>
        <ScrollView style={[styles.files, { borderColor: colors.border }]} contentContainerStyle={{ padding: 6 }}>
          <ReviewTree nodes={tree} depth={0} files={files} selected={selected} collapsed={collapsed} onToggle={path => setCollapsed(current => { const next = new Set(current); if (!next.delete(path)) next.add(path); return next })} onSelect={setSelected} />
        </ScrollView>
        <View style={styles.diffColumn}>
          {errorWarning || sizeWarning ? <View accessibilityRole="alert" style={[styles.inlineWarning, { borderColor: colors.orange, backgroundColor: `${colors.orange}12` }]}><AlertTriangle size={13} color={colors.orange} /><Text selectable style={{ flex: 1, color: colors.orange, fontSize: 10.5 }}>{[errorWarning, sizeWarning].filter(Boolean).join(' ')}</Text></View> : null}
          <ScrollView style={styles.diff} horizontal contentContainerStyle={{ minWidth: '100%' }}><ScrollView contentContainerStyle={{ paddingVertical: 8 }}>{file?.lines.map((line, index) => <ReviewLine key={index} line={line} />)}</ScrollView></ScrollView>
        </View>
      </View>}
    </SafeAreaView>
  </Modal>
}

function ReviewTree({ nodes, depth, files, selected, collapsed, onToggle, onSelect }: {
  nodes: FileTreeNode[]
  depth: number
  files: DiffFile[]
  selected: number
  collapsed: ReadonlySet<string>
  onToggle: (path: string) => void
  onSelect: (index: number) => void
}) {
  const colors = usePalette()
  return <>
    {nodes.map(node => {
      if (node.kind === 'file') return <ReviewFileButton key={`${node.path}:${node.index}`} file={files[node.index]} name={node.name} depth={depth} selected={node.index === selected} onPress={() => onSelect(node.index)} />
      const expanded = !collapsed.has(node.path)
      const stats = directoryStats(node, files)
      return <Fragment key={node.path}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${node.path}, ${stats.count} file${stats.count === 1 ? '' : 's'}, +${stats.additions} -${stats.deletions}`} accessibilityState={{ expanded }} onPress={() => onToggle(node.path)} style={[styles.directory, { paddingLeft: treeIndent(depth) }]}>
          <ChevronRight size={12} color={colors.muted} style={{ transform: [{ rotate: expanded ? '90deg' : '0deg' }] }} />
          <Folder size={12} color={colors.muted} />
          <Text style={{ flex: 1, minWidth: 0, color: colors.muted, fontSize: 11, fontFamily: fonts.mono }} numberOfLines={1}>{node.name}</Text>
          <Text style={{ color: colors.muted, fontSize: 10 }}>{stats.count}</Text>
          <Text style={{ color: colors.green, fontSize: 10 }}>+{stats.additions}</Text><Text style={{ color: colors.red, fontSize: 10 }}>-{stats.deletions}</Text>
        </Pressable>
        {expanded ? <ReviewTree nodes={node.children} depth={depth + 1} files={files} selected={selected} collapsed={collapsed} onToggle={onToggle} onSelect={onSelect} /> : null}
      </Fragment>
    })}
  </>
}

function ReviewFileButton({ file, name, depth, selected, onPress }: { file: DiffFile; name: string; depth: number; selected: boolean; onPress: () => void }) {
  const colors = usePalette()
  const conflict = file.conflictCount ? `, ${file.conflictCount} conflict${file.conflictCount === 1 ? '' : 's'}` : ''
  return <Pressable accessibilityRole="button" accessibilityLabel={`Review ${file.path}${conflict}`} accessibilityState={{ selected }} onPress={onPress} style={[styles.file, { backgroundColor: selected ? colors.raised : 'transparent', paddingLeft: treeIndent(depth) }]}>
    <View style={styles.fileName}><Text style={{ color: colors.text, fontSize: 11, fontFamily: fonts.mono }} numberOfLines={2}>{name}</Text>{file.conflictCount ? <View style={styles.conflictBadge}><AlertTriangle size={10} color={colors.orange} /><Text style={{ color: colors.orange, fontSize: 9, fontWeight: '800' }}>{file.conflictCount}</Text></View> : null}</View>
    <Text style={{ color: colors.green, fontSize: 10 }}>+{file.additions}</Text><Text style={{ color: colors.red, fontSize: 10 }}>-{file.deletions}</Text>
  </Pressable>
}

const treeIndent = (depth: number) => 9 + depth * 12

function directoryStats(node: FileTreeDirectory, files: DiffFile[]): { count: number; additions: number; deletions: number } {
  const stats = { count: 0, additions: 0, deletions: 0 }
  for (const child of node.children) {
    const part = child.kind === 'directory'
      ? directoryStats(child, files)
      : { count: 1, additions: files[child.index].additions, deletions: files[child.index].deletions }
    stats.count += part.count
    stats.additions += part.additions
    stats.deletions += part.deletions
  }
  return stats
}

function ReviewLine({ line }: { line: DiffLine }) {
  const colors = usePalette()
  const prefix = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : line.kind === 'context' ? ' ' : ''
  const conflictColor = line.conflictSide === 'ours' ? colors.blue : line.conflictSide === 'base' ? colors.yellow : line.conflictSide === 'theirs' ? colors.orange : null
  const backgroundColor = conflictColor
    ? `${conflictColor}${line.conflictMarker ? '2A' : '12'}`
    : line.kind === 'add' ? colors.greenSurface : line.kind === 'remove' ? colors.dangerSurface : undefined
  const textColor = conflictColor ?? (line.kind === 'add' ? colors.green : line.kind === 'remove' ? colors.red : colors.text)
  const marker = line.conflictMarker ? conflictMarkerLabel(line.conflictMarker) : null
  return <View accessibilityRole={line.conflictMarker ? 'summary' : undefined} accessibilityLabel={line.conflictMarker ? conflictMarkerAccessibleName(line) : undefined} style={[styles.line, backgroundColor ? { backgroundColor } : undefined]}>
    <Text selectable style={[styles.lineNumber, { color: colors.muted }]}>{line.oldLine ?? ''}</Text>
    <Text selectable style={[styles.lineNumber, { color: colors.muted }]}>{line.newLine ?? ''}</Text>
    <Text selectable style={[styles.code, { color: textColor }]}>{prefix}{line.text || ' '}</Text>
    {marker ? <Text style={[styles.markerLabel, { color: conflictColor ?? colors.orange }]}>{marker}</Text> : null}
  </View>
}

function conflictMarkerLabel(marker: NonNullable<DiffLine['conflictMarker']>): string {
  if (marker === 'start') return 'OURS'
  if (marker === 'base') return 'BASE'
  if (marker === 'separator') return 'THEIRS'
  return 'END'
}

function conflictMarkerAccessibleName(line: DiffLine): string {
  const detail = line.conflictLabel ? `, ${line.conflictLabel}` : ''
  if (line.conflictMarker === 'start') return `Merge conflict: ours section begins${detail}`
  if (line.conflictMarker === 'base') return `Merge conflict: base section begins${detail}`
  if (line.conflictMarker === 'separator') return 'Merge conflict: theirs section begins'
  return `Merge conflict ends${detail}`
}

function connectionIsCurrent(connection: AgentServerClient, profileId: string | null, generation: number): boolean {
  const state = useAppStore.getState()
  return !connection.isDisposed
    && connection.isValidated
    && client === connection
    && state.activeProfileId === profileId
    && state.profileGeneration === generation
    && state.connected
    && !state.connecting
    && !state.switchingProfileId
}

const styles = StyleSheet.create({
  root: { flex: 1 }, header: { minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, flexDirection: 'row', alignItems: 'center', gap: 8 }, title: { fontSize: 15, fontWeight: '800' },
  unavailable: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 }, unavailableText: { maxWidth: 360, textAlign: 'center', fontSize: 12, lineHeight: 18 },
  conflictSummary: { minHeight: 27, borderRadius: 6, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 4 },
  workspace: { flex: 1, flexDirection: 'row' }, files: { width: 260, maxWidth: '34%', borderRightWidth: StyleSheet.hairlineWidth }, file: { minHeight: 54, borderRadius: 5, paddingHorizontal: 9, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 5 }, fileName: { flex: 1, minWidth: 0, gap: 3 },
  directory: { minHeight: 44, borderRadius: 5, paddingHorizontal: 9, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 5 },
  conflictBadge: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 3 },
  diffColumn: { flex: 1, minWidth: 0 }, diff: { flex: 1 }, inlineWarning: { borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 9, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 6 },
  line: { minHeight: 20, flexDirection: 'row', alignItems: 'center' }, lineNumber: { width: 40, paddingRight: 8, textAlign: 'right', fontFamily: fonts.mono, fontSize: 10.5 }, code: { fontFamily: fonts.mono, fontSize: 11.5, paddingRight: 12 }, markerLabel: { marginLeft: 8, marginRight: 8, fontSize: 9, fontWeight: '900' },
})
