import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { ChevronDown, CircleGauge, RefreshCw } from 'lucide-react-native'
import {
  clampPercent,
  formatResetDelay,
  providerUsageReason,
  usedText,
  windowLabel,
  type ProviderUsageSnapshot,
  type UsageBackend,
} from '../lib/provider-usage'
import { subscribeProviderUsageChanged } from '../lib/provider-usage-events'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Session } from '../types'
import { Text } from './AppText'

interface UsageState {
  key: string
  snapshot: ProviderUsageSnapshot | null
  refreshing: boolean
  failed: boolean
}

interface ProviderUsageView {
  backend: UsageBackend | null
  supported: boolean
  connected: boolean
  snapshot: ProviderUsageSnapshot | null
  refreshing: boolean
  failed: boolean
  refresh(): void
}

/**
 * Loads the provider account usage for the selected chat and refetches when the
 * server reports a change. Stays inside the connection-scoping pattern the
 * controls sheets use, so a server switch mid-request is ignored.
 */
function useProviderUsage(session: Session): ProviderUsageView {
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const available = useAppStore(state => {
    const capability = state.health?.capabilities?.provider_usage
    return Boolean(capability && typeof capability === 'object' && !Array.isArray(capability)
      && (capability as { available?: unknown }).available === true)
  })
  const backend: UsageBackend | null = session.backend === 'codex' || session.backend === 'claude' ? session.backend : null
  const supported = available && backend !== null
  const key = `${activeProfileId ?? ''}:${profileGeneration}:${session.id}:${backend ?? ''}`
  const [state, setState] = useState<UsageState>({ key: '', snapshot: null, refreshing: false, failed: false })
  const requestEpoch = useRef(0)
  const refreshRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (!backend || !activeProfileId || !supported) {
      refreshRef.current = () => undefined
      return
    }
    const scopeIsCurrent = (connection: typeof client, epoch: number) => {
      const store = useAppStore.getState()
      return epoch === requestEpoch.current
        && client === connection
        && !connection.isDisposed
        && connection.isValidated
        && store.activeProfileId === activeProfileId
        && store.profileGeneration === profileGeneration
        && store.selectedSessionId === session.id
        && !store.workspaceAdopting
    }
    const read = (refresh: boolean) => {
      const connection = client
      const epoch = ++requestEpoch.current
      setState(previous => ({ key, snapshot: previous.key === key ? previous.snapshot : null, refreshing: true, failed: false }))
      void connection.runtimeUsage(backend, session.id, { refresh })
        .then(snapshot => { if (scopeIsCurrent(connection, epoch)) setState({ key, snapshot, refreshing: false, failed: false }) })
        .catch(() => { if (scopeIsCurrent(connection, epoch)) setState(previous => previous.key === key ? { ...previous, refreshing: false, failed: true } : previous) })
    }
    refreshRef.current = () => read(true)
    const unsubscribe = subscribeProviderUsageChanged(notification => {
      if (notification.profileId !== activeProfileId || notification.profileGeneration !== profileGeneration
        || notification.sessionId !== session.id || notification.backend !== backend) return
      read(false)
    })
    read(false)
    return () => {
      requestEpoch.current += 1
      unsubscribe()
      refreshRef.current = () => undefined
    }
  }, [activeProfileId, profileGeneration, session.id, backend, supported, connected])

  const current = state.key === key
  return {
    backend,
    supported,
    connected,
    snapshot: current ? state.snapshot : null,
    refreshing: current && state.refreshing,
    failed: current && state.failed,
    refresh: () => refreshRef.current(),
  }
}

/** Collapsible "Usage" section (default expanded) for the Codex and Claude thread-controls sheets. */
export function ProviderUsageSection({ session }: { session: Session }) {
  const colors = usePalette()
  const view = useProviderUsage(session)
  const [open, setOpen] = useState(true)
  if (!view.supported || !view.backend) return null
  const { snapshot, refreshing, failed } = view
  const usedValues = snapshot?.status === 'available'
    ? snapshot.windows.flatMap(window => window.used_percent === null ? [] : [clampPercent(window.used_percent)])
    : []
  const summary = snapshot === null
    ? refreshing ? 'Loading usage…' : failed ? 'Could not load usage.' : 'Not available'
    : snapshot.status !== 'available' ? 'Not available'
      : snapshot.windows.some(window => window.status === 'rejected') ? 'Limit reached'
        : usedValues.length ? usedText(Math.max(...usedValues)) : 'Not reported'
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Pressable
        testID="provider-usage-toggle"
        accessibilityRole="button"
        accessibilityLabel={`Usage: ${summary}`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(value => !value)}
        style={styles.header}
      >
        <CircleGauge size={17} color={colors.blue} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.text }]}>Usage</Text>
          <Text style={[styles.summary, { color: colors.muted }]} numberOfLines={1}>{summary}</Text>
        </View>
        <ChevronDown size={16} color={colors.muted} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
      </Pressable>
      {open ? <ProviderUsageBody view={view} backend={view.backend} /> : null}
    </View>
  )
}

function ProviderUsageBody({ view, backend }: { view: ProviderUsageView; backend: UsageBackend }) {
  const colors = usePalette()
  const { snapshot, connected, refreshing, failed, refresh } = view
  const now = Date.now()
  return (
    <View style={styles.body}>
      {snapshot?.status === 'available' ? snapshot.windows.map(window => {
        const label = windowLabel(window, backend)
        const used = window.used_percent === null ? null : clampPercent(window.used_percent)
        const accent = window.status === 'rejected' ? colors.red : window.status === 'allowed_warning' ? colors.orange : colors.blue
        const resetsAt = window.resets_at === null ? null : window.resets_at * 1000
        const delay = resetsAt === null ? null : formatResetDelay(resetsAt, now)
        return (
          <View key={window.id} style={[styles.window, { backgroundColor: colors.background }]}>
            <View style={styles.row}>
              <Text style={[styles.windowLabel, { color: colors.text }]} numberOfLines={1}>{label}</Text>
              <Text style={[styles.windowValue, { color: window.status === 'rejected' ? colors.red : colors.text }]}>
                {used === null ? window.status === 'rejected' ? 'Limit reached' : 'Not reported' : usedText(used)}
              </Text>
            </View>
            {used === null ? null : (
              <View
                accessible
                accessibilityRole="progressbar"
                accessibilityLabel={`${label} used`}
                accessibilityValue={{ min: 0, max: 100, now: Math.round(used), text: usedText(used) }}
                style={[styles.track, { backgroundColor: colors.border }]}
              >
                <View style={[styles.trackValue, { width: `${used}%`, backgroundColor: accent }]} />
              </View>
            )}
            {resetsAt === null ? null : (
              <Text style={[styles.note, { color: colors.muted }]}>{delay === null ? `Resets ${formatClock(resetsAt)}` : `Resets in ${delay}`}</Text>
            )}
          </View>
        )
      }) : null}
      {snapshot?.credits ? (
        <View style={[styles.window, styles.row, { backgroundColor: colors.background }]}>
          <Text style={[styles.windowLabel, { color: colors.text }]}>Credits</Text>
          <Text style={[styles.windowValue, { color: colors.text }]}>{
            snapshot.credits.unlimited ? 'Unlimited' : snapshot.credits.balance !== null ? snapshot.credits.balance
              : snapshot.credits.has_credits ? 'Available' : 'None remaining'
          }</Text>
        </View>
      ) : null}
      {snapshot?.status === 'unavailable' ? (
        <Text testID="provider-usage-reason" style={[styles.reason, { color: colors.muted }]}>{providerUsageReason(snapshot.reason, backend)}</Text>
      ) : null}
      <View style={styles.footer}>
        {!snapshot && refreshing ? <Text style={[styles.note, { color: colors.muted }]}>Loading usage…</Text> : null}
        {!connected ? <Text style={[styles.note, { color: colors.muted }]}>Offline — showing the last report.</Text> : null}
        {failed ? <Text style={[styles.note, { color: colors.red }]}>{snapshot ? 'Could not refresh. Showing the last report.' : 'Could not load usage.'}</Text> : null}
        {snapshot?.observed_at ? <Text style={[styles.note, { color: colors.muted }]}>Reported {formatClock(Date.parse(snapshot.observed_at))}</Text> : null}
        {snapshot?.source === 'claude-events' ? <Text style={[styles.note, { color: colors.muted }]}>Claude reports limits during use; other windows may not have been reported yet.</Text> : null}
        <Pressable
          testID="provider-usage-refresh"
          accessibilityRole="button"
          accessibilityLabel="Refresh usage"
          accessibilityState={{ disabled: !connected || refreshing }}
          disabled={!connected || refreshing}
          onPress={refresh}
          style={({ pressed }) => [styles.refresh, { backgroundColor: colors.raised, opacity: !connected || refreshing ? 0.4 : pressed ? 0.68 : 1 }]}
        >
          {refreshing ? <ActivityIndicator size="small" color={colors.muted} /> : <RefreshCw size={13} color={colors.text} />}
          <Text style={{ color: colors.text, fontSize: 11.5, fontWeight: '800' }}>Refresh</Text>
        </Pressable>
      </View>
    </View>
  )
}

function formatClock(value: number): string {
  return Number.isFinite(value)
    ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '—'
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 9, padding: 11, gap: 10 },
  header: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 13.5, fontWeight: '900' },
  summary: { fontSize: 10.5, marginTop: 2 },
  body: { gap: 9 },
  window: { borderRadius: 7, padding: 9, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  windowLabel: { flex: 1, minWidth: 0, fontSize: 11.5, fontWeight: '700' },
  windowValue: { fontSize: 11.5, fontWeight: '800', fontVariant: ['tabular-nums'] },
  track: { height: 6, overflow: 'hidden', borderRadius: 3 },
  trackValue: { height: '100%', borderRadius: 3 },
  note: { fontSize: 10.5, lineHeight: 15 },
  reason: { fontSize: 11.5, lineHeight: 16 },
  footer: { gap: 6 },
  refresh: { alignSelf: 'flex-end', minHeight: 40, borderRadius: 7, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
})
