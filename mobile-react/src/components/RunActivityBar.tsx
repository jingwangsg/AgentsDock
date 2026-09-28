// Live "Working…" strip pinned under the timeline while a turn runs; collapses to
// the desktop's "Worked for …" summary once the turn ends. The turn's subagent
// rows sit beneath it, as in the Claude Code CLI.
import { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { latestRunActivity, runActivityLabel } from '../lib/run-activity'
import { isSubagentActive, subagentDisplayName, subagentsFromEvents } from '../lib/subagents'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Event } from '../types'
import { Text } from './AppText'
import { SubagentRows } from './SubagentRows'

const EMPTY_EVENTS: Event[] = []
const EMPTY_SUBAGENT_STATES: Record<string, Event> = {}

export function RunActivityBar({ sessionId }: { sessionId: string }) {
  const colors = usePalette()
  const active = useAppStore(state => state.activeSessionIds.has(sessionId))
  const events = useAppStore(state => state.snapshots[sessionId]?.events ?? EMPTY_EVENTS)
  const backend = useAppStore(state => state.snapshots[sessionId]?.session.backend)
  const subagentStates = useAppStore(state => state.subagentsBySession[sessionId] ?? EMPTY_SUBAGENT_STATES)
  const activity = useMemo(() => latestRunActivity(events), [events])
  const subagents = useMemo(() => {
    // The phone drops streamed Claude raw packets, so the snapshot route's state
    // records are merged with the timeline's tool lifecycle; the parser sorts by seq.
    let runId: string | null = null
    for (let index = events.length - 1; index >= 0 && !runId; index -= 1) {
      if (events[index].type === 'turn_started') runId = events[index].run_id?.trim() || null
    }
    if (!runId) return []
    const owner = backend === 'claude' || backend === 'codex' ? backend : undefined
    return subagentsFromEvents([...events, ...Object.values(subagentStates)], owner)
      .filter(agent => agent.runId === runId)
      // Spawn order, like the CLI's Task rows; the session-wide list is newest-first.
      .sort((a, b) => Date.parse(a.startedAt || '0') - Date.parse(b.startedAt || '0'))
  }, [backend, events, subagentStates])
  const anySubagentActive = subagents.some(isSubagentActive)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active && !anySubagentActive) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, anySubagentActive])
  const label = runActivityLabel(activity, active, now, subagents.filter(isSubagentActive).map(subagentDisplayName))
  if (!label) return null
  return <>
    <View
      testID="run-activity"
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={label.elapsed ? `${label.title} ${label.elapsed}` : label.title}
      style={[styles.root, { borderColor: colors.border, backgroundColor: colors.raised }]}
    >
      {label.live ? <ActivityIndicator size="small" color={colors.blue} /> : null}
      <Text style={[styles.title, { color: label.live ? colors.text : colors.muted }]} numberOfLines={1}>{label.title}</Text>
      {label.elapsed ? <Text style={[styles.elapsed, { color: colors.muted }]}>{label.elapsed}</Text> : null}
    </View>
    {subagents.length ? <SubagentRows agents={subagents} now={now} runLive={label.live} /> : null}
  </>
}

const styles = StyleSheet.create({
  root: { marginHorizontal: 14, marginBottom: 6, minHeight: 32, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 5, flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 12, fontWeight: '700', flexShrink: 1 },
  elapsed: { fontSize: 12, fontVariant: ['tabular-nums'] },
})
