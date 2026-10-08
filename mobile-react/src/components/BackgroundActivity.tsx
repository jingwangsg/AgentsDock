import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { BackgroundActivityItem } from '../lib/background-activity'
import { fonts } from '../lib/typography'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { Text } from './AppText'
import { SheetCloseButton } from './ui'

// Codex has no push when a background terminal exits, and a Claude task starts mid-turn without one; listed items, and a running Claude turn, are re-checked on this interval.
const RECHECK_MS = 15_000

/** Header chip for what keeps running for a chat outside its turn: Codex background terminals, or Claude's background shells (its agents have subagent rows). */
export function BackgroundActivityButton({ sessionId }: { sessionId: string }) {
  const colors = usePalette()
  const backend = useAppStore(state => state.sessions.find(session => session.id === sessionId)?.backend)
  const isClaude = backend === 'claude'
  const available = useAppStore(state => (backend === 'codex' || isClaude) && state.health?.capabilities?.background_activity_v1?.available === true)
  const connected = useAppStore(state => state.connected)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const running = useAppStore(state => state.activeSessionIds.has(sessionId))
  const [items, setItems] = useState<BackgroundActivityItem[]>([])
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState<string | null>(null)
  const request = useRef(0)

  const load = useCallback(() => {
    if (!available || !connected) return
    const connection = client
    const current = ++request.current
    void connection.backgroundActivity(sessionId)
      .then(next => { if (request.current === current && client === connection) setItems(next) })
      .catch(() => undefined)
  }, [available, connected, profileId, profileGeneration, sessionId])

  useEffect(() => setItems([]), [load])
  // `running`: a Codex background terminal starts during a turn and is listed from its end.
  useEffect(load, [load, running])
  // A Claude task starts mid-turn and keeps the turn open, so a Claude turn is re-checked too.
  useEffect(() => {
    if (!items.length && !(isClaude && running)) return
    const timer = setInterval(load, RECHECK_MS)
    return () => clearInterval(timer)
  }, [items, isClaude, running, load])

  const stop = (item: BackgroundActivityItem) => Alert.alert(`Stop “${item.command || item.id}”?`, undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Stop', style: 'destructive', onPress: () => {
      const connection = client
      setStopping(item.id)
      void connection.stopBackgroundActivity(sessionId, item.id).catch(() => false)
        .then(stopped => {
          if (!stopped) Alert.alert('Could not stop it', 'It may have already finished.')
          setStopping(null)
          load()
        })
    } },
  ])

  if (!items.length) return null
  const title = isClaude ? 'Background shells' : 'Background terminals'
  return <>
    <Pressable testID="background-activity" accessibilityRole="button" accessibilityLabel={`${title}: ${items.length} running`} onPress={() => setOpen(true)} hitSlop={6}
      style={[styles.chip, { backgroundColor: colors.raised }]}>
      <ActivityIndicator size="small" color={colors.blue} />
      <Text style={[styles.chipText, { color: colors.text }]}>{items.length}</Text>
    </Pressable>
    <Modal visible={open} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
          <SheetCloseButton label={`Close ${title.toLowerCase()}`} onPress={() => setOpen(false)} />
        </View>
        <ScrollView contentContainerStyle={styles.list}>
          {items.map(item => <View key={item.id} style={[styles.item, { borderColor: colors.border }]}>
            <Text selectable style={[styles.command, { color: colors.text }]} numberOfLines={3}>{item.command || item.id}</Text>
            {/* The Claude SDK has no call that ends one task. */}
            {!isClaude && <Pressable accessibilityRole="button" accessibilityLabel={`Stop ${item.command || item.id}`} disabled={stopping !== null} onPress={() => stop(item)} hitSlop={8}>
              {stopping === item.id ? <ActivityIndicator size="small" color={colors.red} /> : <Text style={[styles.stop, { color: colors.red }]}>Stop</Text>}
            </Pressable>}
          </View>)}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  </>
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  chip: { minHeight: 30, paddingHorizontal: 8, borderRadius: 15, flexDirection: 'row', alignItems: 'center', gap: 4 },
  chipText: { fontSize: 12, fontWeight: '700' },
  header: { minHeight: 56, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 17, fontWeight: '800' },
  list: { padding: 14, gap: 10 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  command: { flex: 1, minWidth: 0, fontSize: 13, fontFamily: fonts.mono },
  stop: { fontSize: 14, fontWeight: '700' },
})
