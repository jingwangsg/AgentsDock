// "Outputs & sources" page sheet for one chat: port of the Electron ChatOutputsPanel without canvas rows.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { FileDiff, FileText, Globe, Image, MessageSquare, Paperclip, Plug, Search, Sparkles, type LucideIcon } from 'lucide-react-native'
import { collectChatOutputs, type ChatOutputsSummary } from '../lib/chat-outputs'
import { mobileFileViewerKind } from '../lib/file-viewer'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Event } from '../types'
import { Text } from './AppText'
import { SheetCloseButton } from './ui'
import { useFileViewer } from './file-viewer/FileViewerContext'

const COLLAPSED_SOURCE_ROWS = 6
const REFRESH_DEBOUNCE_MS = 1_000
// UIKit acknowledges a page-sheet dismissal through onDismiss; the fallback
// covers an interrupted transition (same as AppShell's inspector handoff).
const IOS_DISMISS_FALLBACK_MS = 1_000
const EMPTY_EVENTS: Event[] = []

export function ChatOutputsPanel({ sessionId, visible, onClose, onReview }: { sessionId: string; visible: boolean; onClose: () => void; onReview: (runId: string) => void }) {
  const colors = usePalette()
  const events = useAppStore(state => state.snapshots[sessionId]?.events ?? EMPTY_EVENTS)
  const hasMore = useAppStore(state => Boolean(state.snapshots[sessionId]?.hasMore))
  const total = useAppStore(state => state.snapshots[sessionId]?.total ?? null)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const seekTimelineResult = useAppStore(state => state.seekTimelineResult)
  const { openArtifacts } = useFileViewer()
  const [summary, setSummary] = useState<ChatOutputsSummary | null>(null)
  const [allSources, setAllSources] = useState(false)
  const firstLoad = useRef(true)
  const pendingAction = useRef<(() => void) | null>(null)
  const dismissFallback = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!visible) {
      firstLoad.current = true
      return
    }
    // Immediate on open; later event batches (including history_rewound) coalesce
    // so a streaming turn does not recompute per token.
    const timer = setTimeout(() => setSummary(collectChatOutputs(events)), firstLoad.current ? 0 : REFRESH_DEBOUNCE_MS)
    firstLoad.current = false
    return () => clearTimeout(timer)
  }, [events, visible])

  // Row actions present another surface (file viewer, review sheet, timeline
  // seek), so they run only after this sheet has finished dismissing.
  const finishDismissal = useCallback(() => {
    if (dismissFallback.current != null) clearTimeout(dismissFallback.current)
    dismissFallback.current = null
    const action = pendingAction.current
    pendingAction.current = null
    action?.()
  }, [])
  const closeThen = useCallback((action: () => void) => {
    pendingAction.current = action
    onClose()
    if (Platform.OS !== 'ios') {
      requestAnimationFrame(finishDismissal)
      return
    }
    dismissFallback.current = setTimeout(finishDismissal, IOS_DISMISS_FALLBACK_MS)
  }, [finishDismissal, onClose])
  useEffect(() => () => { if (dismissFallback.current != null) clearTimeout(dismissFallback.current) }, [])

  const eventById = (eventId: string) => events.find(event => event.id === eventId)
  const jumpTo = (eventId: string) => {
    const event = eventById(eventId)
    if (!event) return
    // The timeline's only jump mechanism is the search-result seek; it reads session_id, event_id and seq.
    closeThen(() => void seekTimelineResult({ session_id: sessionId, event_id: event.id, seq: event.seq, role: 'trace', snippet: '' }, profileGeneration))
  }
  const plural = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`
  const sources = summary?.sources ?? []
  const visibleSources = allSources ? sources : sources.slice(0, COLLAPSED_SOURCE_ROWS)

  return <Modal visible={visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={onClose} onDismiss={finishDismissal}>
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={['bottom']}>
      <View style={styles.grabber} />
      <View style={styles.top}>
        <Text style={[styles.title, { color: colors.text }]}>Outputs & sources</Text>
        <SheetCloseButton onPress={onClose} label="Close outputs and sources" testID="chat-outputs-close" />
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="always">
        <Text style={[styles.section, { color: colors.muted }]}>Outputs</Text>
        {summary && summary.outputs.length === 0 ? <Text style={[styles.empty, { color: colors.muted }]}>No outputs yet</Text> : null}
        {summary?.outputs.map(item => {
          switch (item.kind) {
            case 'artifact': {
              const kind = mobileFileViewerKind(item.filename, item.contentType)
              const media = kind === 'image' || kind === 'video'
              const extension = /\.([a-z0-9]+)$/i.exec(item.filename)?.[1]
              const file = eventById(item.eventId)?.artifact
              return <Row key={`artifact:${item.eventId}:${item.filename}`} icon={media ? Image : FileText} label={item.label}
                secondary={media ? 'Generated image' : extension ? `${extension.toUpperCase()} file` : 'File'}
                onPress={file ? () => closeThen(() => openArtifacts({ sessionId, files: [file], initialId: file.id, ownerKey: `chat-outputs:${file.id}` })) : undefined} />
            }
            case 'local_preview':
              return <Row key={`preview:${item.host}`} icon={Globe} label="Local preview" secondary={item.host} onPress={() => void Linking.openURL(item.url)} />
            case 'code_changes': {
              const runId = item.review.runId
              return <Row key="code-changes" icon={FileDiff} label={`Edited ${plural(item.filesChanged, 'file', 'files')}`} secondary={`+${item.additions} −${item.deletions}`}
                onPress={runId ? () => closeThen(() => onReview(runId)) : undefined} />
            }
          }
        })}
        <Text style={[styles.section, styles.sectionGap, { color: colors.muted }]}>Sources</Text>
        {summary && sources.length === 0 ? <Text style={[styles.empty, { color: colors.muted }]}>No sources yet</Text> : null}
        {visibleSources.map(item => {
          switch (item.kind) {
            case 'mcp':
              return <Row key={`mcp:${item.label}`} icon={Plug} label={item.label} secondary={plural(item.count, 'use', 'uses')} onPress={() => jumpTo(item.eventId)} />
            case 'web_search':
              return <Row key="web-search" icon={Search} label="Web search" secondary={`Searched ${plural(item.count, 'time', 'times')}`} onPress={() => jumpTo(item.eventId)} />
            case 'web_fetch':
              return <Row key="web-fetch" icon={Globe} label="Web pages" secondary={`Opened ${plural(item.count, 'page', 'pages')}`} onPress={() => jumpTo(item.eventId)} />
            case 'skill':
              return <Row key={`skill:${item.label}`} icon={Sparkles} label={item.label} secondary="Skill" onPress={() => jumpTo(item.eventId)} />
            case 'chat_reference':
              return <Row key={`chat:${item.eventId}:${item.label}`} icon={MessageSquare} label={item.label} secondary="Referenced chat" onPress={() => jumpTo(item.eventId)} />
            case 'attached_file':
              return <Row key={`file:${item.eventId}:${item.label}`} icon={Paperclip} label={item.label} secondary="Attached to this chat" onPress={() => jumpTo(item.eventId)} />
          }
        })}
        {sources.length > COLLAPSED_SOURCE_ROWS ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: allSources }} onPress={() => setAllSources(value => !value)} style={styles.more}>
          <Text style={[styles.moreText, { color: colors.blue }]}>{allSources ? 'Show less' : `View all (${sources.length})`}</Text>
        </Pressable> : null}
        {hasMore ? <Text testID="chat-outputs-truncated" style={[styles.footer, { color: colors.muted }]}>Based on the {events.length} loaded events{total ? ` of ${total}` : ''}. Older history is not included.</Text> : null}
      </ScrollView>
    </SafeAreaView>
  </Modal>
}

function Row({ icon: Icon, label, secondary, onPress }: { icon: LucideIcon; label: string; secondary: string; onPress?: () => void }) {
  const colors = usePalette()
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={`${label}. ${secondary}`}
    accessibilityState={{ disabled: !onPress }}
    disabled={!onPress}
    onPress={onPress}
    style={({ pressed }) => [styles.row, { borderColor: colors.border, backgroundColor: colors.surface, opacity: pressed ? 0.6 : 1 }]}
  >
    <Icon size={16} color={colors.muted} strokeWidth={1.8} />
    <View style={styles.rowText}>
      <Text style={[styles.rowLabel, { color: colors.text }]} numberOfLines={1}>{label}</Text>
      <Text style={[styles.rowSecondary, { color: colors.muted }]} numberOfLines={1}>{secondary}</Text>
    </View>
  </Pressable>
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grabber: { alignSelf: 'center', width: 36, height: 5, marginTop: 7, borderRadius: 3, backgroundColor: '#8a8a8a88' },
  top: { minHeight: 64, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, flexDirection: 'row', alignItems: 'center' },
  title: { flex: 1, fontSize: 16, fontWeight: '800' },
  content: { paddingHorizontal: 14, paddingBottom: 24, gap: 8 },
  section: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.4 },
  sectionGap: { marginTop: 14 },
  empty: { fontSize: 12 },
  row: { minHeight: 52, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { fontSize: 13, fontWeight: '700' },
  rowSecondary: { fontSize: 11 },
  more: { minHeight: 44, justifyContent: 'center' },
  moreText: { fontSize: 12, fontWeight: '800' },
  footer: { marginTop: 14, fontSize: 11, lineHeight: 15 },
})
