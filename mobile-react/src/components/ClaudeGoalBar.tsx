import { useEffect, useState } from 'react'
import { Alert, Pressable, StyleSheet, View } from 'react-native'
import { Goal, Pencil, Trash2 } from 'lucide-react-native'
import { usePalette } from '../theme'
import { Text } from './AppText'
import { useClaudeRuntime } from './ClaudeRuntimeContext'

/**
 * The chat's native Claude goal while it is active, as the desktop's summary bar shows it.
 * Claude keeps the goal across stopped turns, so the bar stays until the goal is achieved or cleared.
 */
export function ClaudeGoalBar({ onEdit, onClear }: { onEdit: () => void; onClear: () => void }) {
  const colors = usePalette()
  const { supported, runtime, mutating } = useClaudeRuntime()
  const goal = runtime?.goal ?? null
  const busy = runtime?.status?.type === 'active'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (goal?.status !== 'active' || goal.set_at == null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [goal?.status, goal?.set_at])
  if (!supported || runtime?.features?.goals !== true || goal?.status !== 'active') return null
  const elapsed = goalElapsed(goal.duration_ms ?? (goal.set_at != null ? now - goal.set_at : NaN))
  const metadata = [goal.iterations != null ? `${goal.iterations} iterations` : null, elapsed].filter(Boolean).join(' · ')
  const clearLabel = busy ? 'Clear & stop' : 'Clear'
  const confirmClear = () => {
    Alert.alert(busy ? 'Clear the goal and stop current work?' : 'Clear Claude goal?', goal.condition, [
      { text: 'Cancel', style: 'cancel' },
      { text: busy ? 'Clear & stop' : 'Clear goal', style: 'destructive', onPress: onClear },
    ])
  }
  // Replacing needs a new /goal turn, which the server refuses while one is running. The
  // desktop opens its dialog and says so; a silently disabled pencil only looked broken here.
  const explainBusy = () => {
    Alert.alert('Claude is still working', 'Clear & stop before replacing this goal.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear & stop', style: 'destructive', onPress: onClear },
    ])
  }
  return <View testID="claude-goal-bar" accessibilityLabel="Claude goal" style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.blue }]}>
    <Pressable testID="claude-goal-edit" accessibilityRole="button" accessibilityLabel="Edit Claude goal" accessibilityHint={busy ? 'Explains why the goal cannot be replaced yet' : undefined} disabled={mutating} onPress={busy ? explainBusy : onEdit} style={styles.summary}>
      <Goal size={18} color={colors.blue} />
      <View style={styles.grow}>
        <Text testID="claude-goal-condition" style={[styles.condition, { color: colors.text }]} numberOfLines={2}>{goal.condition}</Text>
        {metadata ? <Text style={[styles.meta, { color: colors.muted }]}>{metadata}</Text> : null}
      </View>
      <Pencil size={16} color={colors.muted} />
    </Pressable>
    <Pressable
      testID="claude-goal-clear"
      accessibilityRole="button"
      accessibilityLabel={busy ? 'Clear the goal and stop current work' : 'Clear Claude goal'}
      disabled={mutating}
      onPress={confirmClear}
      style={[styles.action, { backgroundColor: colors.raised, opacity: mutating ? 0.5 : 1 }]}
    ><Trash2 size={15} color={colors.red} /><Text style={[styles.actionLabel, { color: colors.red }]}>{clearLabel}</Text></Pressable>
  </View>
}

function goalElapsed(durationMs: number): string | null {
  if (!Number.isFinite(durationMs)) return null
  const seconds = Math.max(0, Math.floor(durationMs / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 5, marginBottom: 7, flexDirection: 'row', alignItems: 'center', gap: 8 },
  summary: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  condition: { fontSize: 12, lineHeight: 17 },
  meta: { fontSize: 10.5, lineHeight: 15, fontVariant: ['tabular-nums'] },
  action: { minHeight: 44, paddingHorizontal: 10, borderRadius: 7, flexDirection: 'row', alignItems: 'center', gap: 5 },
  actionLabel: { fontSize: 12, fontWeight: '700' },
})
