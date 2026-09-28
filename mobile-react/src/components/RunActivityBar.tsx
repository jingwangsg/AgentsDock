// Live "Working…" strip pinned under the timeline while a turn runs; collapses to
// the desktop's "Worked for …" summary once the turn ends.
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { latestRunActivity, runActivityLabel } from '../lib/run-activity'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Event } from '../types'
import { Text } from './AppText'

const EMPTY_EVENTS: Event[] = []

export function RunActivityBar({ sessionId }: { sessionId: string }) {
  const colors = usePalette()
  const active = useAppStore(state => state.activeSessionIds.has(sessionId))
  const events = useAppStore(state => state.snapshots[sessionId]?.events ?? EMPTY_EVENTS)
  const activity = useMemo(() => latestRunActivity(events), [events])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  const label = runActivityLabel(activity, active, now)
  if (!label) return null
  return <View
    testID="run-activity"
    accessible
    accessibilityRole="text"
    accessibilityLiveRegion="polite"
    accessibilityLabel={label.elapsed ? `${label.title} ${label.elapsed}` : label.title}
    style={[styles.root, { borderColor: colors.border, backgroundColor: colors.raised }]}
  >
    {label.live ? <ActivityIndicator size="small" color={colors.blue} /> : null}
    <Text style={[styles.title, { color: label.live ? colors.text : colors.muted }]}>{label.title}</Text>
    {label.elapsed ? <Text style={[styles.elapsed, { color: colors.muted }]}>{label.elapsed}</Text> : null}
  </View>
}

const styles = StyleSheet.create({
  root: { marginHorizontal: 14, marginBottom: 6, minHeight: 32, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 12, fontWeight: '700' },
  elapsed: { fontSize: 12, fontVariant: ['tabular-nums'] },
})
