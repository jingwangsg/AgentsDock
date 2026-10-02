import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Svg, { Circle } from 'react-native-svg'
import { Bot, RefreshCw } from 'lucide-react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import {
  formatClaudeContextUsageDetail,
  formatContextPercent,
  parseClaudeContextUsage,
} from '../lib/claude-context-usage'
import { usePalette } from '../theme'
import { Text } from './AppText'
import { useClaudeRuntime } from './ClaudeRuntimeContext'
import { ProviderUsageSection } from './ProviderUsagePanel'
import { IconButton, SheetCloseButton } from './ui'

export function ClaudeContextIndicator() {
  const colors = usePalette()
  const {
    supported,
    runtime,
    session,
    refreshing,
    mutating,
    contextUsageError,
    refreshContextUsage,
    run,
  } = useClaudeRuntime()
  const [open, setOpen] = useState(false)
  const [compactNotice, setCompactNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const rawUsage = runtime
    ? runtime.context_usage_snapshot !== undefined
      ? runtime.context_usage_snapshot
      : runtime.context_usage
    : undefined
  const usage = useMemo(() => parseClaudeContextUsage(rawUsage), [rawUsage])
  useEffect(() => {
    if (supported || !open) return
    setOpen(false)
    requestAnimationFrame(dismissAppKeyboard)
  }, [open, supported])
  useEffect(() => { setCompactNotice(null) }, [open, session?.id])
  if (!supported || !session) return null
  const percent = usage?.contextPercent ?? null
  const formattedPercent = formatContextPercent(percent)
  const detail = formatClaudeContextUsageDetail(usage)
  const state = runtime?.context_usage_state ?? (usage ? 'available' : 'unavailable')
  const supportsOnDemandRefresh = runtime?.features?.context_usage_refresh === true
  const runtimeStatus = runtime?.status?.type
  const canSampleNow = supportsOnDemandRefresh && runtimeStatus === 'idle'
  const canRefresh = !supportsOnDemandRefresh || canSampleNow
  const refreshStatus = refreshing
    ? 'Refreshing directly from Claude…'
    : contextUsageError
      ? `Refresh failed: ${contextUsageError}`
      : canSampleNow
        ? 'Tap refresh to sample Claude now.'
        : supportsOnDemandRefresh && runtimeStatus === 'active'
          ? 'Context refreshes when the current Claude response finishes.'
          : supportsOnDemandRefresh
            ? 'Context becomes refreshable after the next Claude response.'
            : 'Updated after completed Claude SDK turns.'
  const compactAvailable = runtime?.features?.compact === true
  const compacting = runtime?.compacting === true
  const compactEnabled = !mutating && !compacting && runtime?.available === true && runtimeStatus !== 'active'
  const compact = () => {
    setCompactNotice(null)
    run((connection, id) => connection.compactClaudeContext(id))
      .then(() => setCompactNotice({ tone: 'ok', text: 'Context compaction started.' }))
      .catch(error => setCompactNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) }))
  }
  const circumference = Math.PI * 16
  const close = () => { setOpen(false); requestAnimationFrame(dismissAppKeyboard) }
  const openDetails = () => {
    setOpen(true)
    requestAnimationFrame(dismissAppKeyboard)
    if (!refreshing && canRefresh) void refreshContextUsage()
  }

  return <>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Claude context usage: ${percent == null ? 'Unavailable' : formattedPercent}. Open details`}
      accessibilityValue={percent == null
        ? { text: 'Not available' }
        : { min: 0, max: 100, now: Math.round(percent), text: `${formattedPercent} context used` }}
      testID="claude-context-usage"
      onPress={openDetails}
      style={({ pressed }) => [styles.indicator, { opacity: pressed ? 0.62 : 1 }]}
    >
      {refreshing && !runtime ? <ActivityIndicator size="small" color={colors.muted} /> : <Svg width={22} height={22} viewBox="0 0 22 22">
        <Circle cx={11} cy={11} r={8} fill="none" stroke={colors.border} strokeWidth={2.5} strokeDasharray={percent == null ? [2, 3] : undefined} />
        {percent == null ? null : <Circle
          cx={11}
          cy={11}
          r={8}
          fill="none"
          stroke={colors.muted}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray={[circumference, circumference]}
          strokeDashoffset={circumference * (1 - percent / 100)}
          rotation={-90}
          origin="11, 11"
        />}
      </Svg>}
    </Pressable>
    {open ? <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal onRequestClose={close}>
      <SafeAreaView accessibilityViewIsModal onAccessibilityEscape={close} style={[styles.sheet, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <View style={[styles.headerMark, { backgroundColor: colors.raised }]}><Bot size={19} color={colors.blue} /></View>
          <View style={styles.headerCopy}>
            <Text style={[styles.title, { color: colors.text }]}>Claude context</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>Agent SDK context consumption</Text>
          </View>
          <IconButton testID="claude-context-refresh" icon={RefreshCw} label="Refresh Claude context" disabled={refreshing || !canRefresh} onPress={() => void refreshContextUsage()} />
          <SheetCloseButton label="Close Claude context" testID="claude-context-close" onPress={close} />
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>
          <View style={[styles.meter, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <Svg width={88} height={88} viewBox="0 0 22 22">
              <Circle cx={11} cy={11} r={8} fill="none" stroke={colors.border} strokeWidth={2.5} strokeDasharray={percent == null ? [2, 3] : undefined} />
              {percent == null ? null : <Circle
                cx={11}
                cy={11}
                r={8}
                fill="none"
                stroke={colors.blue}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray={[circumference, circumference]}
                strokeDashoffset={circumference * (1 - percent / 100)}
                rotation={-90}
                origin="11, 11"
              />}
            </Svg>
            <Text style={[styles.percent, { color: colors.text }]}>{formattedPercent}</Text>
          </View>
          <Text style={[styles.detail, { color: colors.text }]}>{detail}</Text>
          <Text style={[styles.state, { color: colors.muted }]}>State: {contextStateLabel(state)}</Text>
          <Text accessibilityLiveRegion="polite" selectable={Boolean(contextUsageError)} style={[styles.note, { color: contextUsageError ? colors.red : colors.muted }]}>{refreshStatus}</Text>
          <Text style={[styles.note, { color: colors.muted }]}>Direct sampling is available only for an idle, already-loaded Agent SDK session. Legacy servers keep the last completed-turn snapshot.</Text>
          {compactAvailable ? <View style={[styles.compactRow, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.compactTitle, { color: colors.text }]}>Compact context</Text>
              <Text style={[styles.compactDescription, { color: colors.muted }]}>{compacting ? 'Compacting context…' : "Ask Claude to summarize this chat's context in place."}</Text>
            </View>
            <Pressable
              testID="claude-context-compact"
              accessibilityRole="button"
              accessibilityLabel="Compact"
              accessibilityState={{ disabled: !compactEnabled }}
              disabled={!compactEnabled}
              onPress={compact}
              style={({ pressed }) => [styles.compactButton, { backgroundColor: colors.raised, opacity: !compactEnabled ? 0.4 : pressed ? 0.68 : 1 }]}
            >
              {compacting ? <ActivityIndicator size="small" color={colors.text} /> : <Text style={{ color: colors.text, fontSize: 11.5, fontWeight: '800' }}>Compact</Text>}
            </Pressable>
          </View> : null}
          {compactNotice ? <Text accessibilityLiveRegion="polite" style={[styles.note, { color: compactNotice.tone === 'error' ? colors.red : colors.green }]}>{compactNotice.text}</Text> : null}
          <View style={styles.usage}><ProviderUsageSection session={session} /></View>
        </ScrollView>
      </SafeAreaView>
    </Modal> : null}
  </>
}

function contextStateLabel(state: 'available' | 'cleared' | 'unavailable'): string {
  if (state === 'available') return 'Available'
  if (state === 'cleared') return 'Cleared for a new provider session'
  return 'Not available yet'
}

const styles = StyleSheet.create({
  indicator: { width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  sheet: { flex: 1 },
  header: { minHeight: 70, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerMark: { width: 40, height: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { minWidth: 0, flex: 1 },
  title: { fontSize: 17, fontWeight: '900' },
  subtitle: { marginTop: 2, fontSize: 10.5 },
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', alignItems: 'center', padding: 24, gap: 12 },
  meter: { width: 142, height: 142, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  percent: { position: 'absolute', fontSize: 18, fontWeight: '900' },
  detail: { textAlign: 'center', fontSize: 14, fontWeight: '700', lineHeight: 20 },
  state: { textAlign: 'center', fontSize: 11.5, lineHeight: 17 },
  note: { maxWidth: 460, textAlign: 'center', fontSize: 10.5, lineHeight: 15 },
  compactRow: { alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 12, marginTop: 4 },
  compactTitle: { fontSize: 13, fontWeight: '800' },
  compactDescription: { marginTop: 2, fontSize: 11, lineHeight: 15 },
  compactButton: { minWidth: 72, minHeight: 34, paddingHorizontal: 12, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  usage: { alignSelf: 'stretch', marginTop: 4 },
})
