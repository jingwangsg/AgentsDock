import { AlertTriangle, X } from 'lucide-react-native'
import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { sessionNeedsProviderInteraction } from '../lib/claude-controls'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { IconButton } from './ui'

/** One line above the content naming the chats whose agent is waiting for an answer
 *  or an approval. The chat on screen is left out: its shelf already shows the
 *  request. Hiding it lasts until a different set of chats is waiting. */
export function WaitingForYouBanner({ onScreenSessionId, onOpen }: { onScreenSessionId: string | null; onOpen: (sessionId: string) => void }) {
  const colors = usePalette()
  const sessions = useAppStore(state => state.sessions)
  const [hidden, setHidden] = useState('')
  const waiting = useMemo(
    () => sessions.filter(session => !session.archived && session.id !== onScreenSessionId && sessionNeedsProviderInteraction(session)),
    [sessions, onScreenSessionId],
  )
  const key = waiting.map(session => session.id).sort().join(' ')
  if (!waiting.length || key === hidden) return null
  const [first] = waiting
  const text = waiting.length === 1
    ? `${first.backend === 'codex' ? 'Codex' : 'Claude'} is waiting for you in “${first.title || first.id}”`
    : `${waiting.length} chats are waiting for you: ${waiting.map(session => session.title || session.id).join(', ')}`
  return <View testID="waiting-banner" style={styles.slot}>
    <View style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.orange }]}>
      <AlertTriangle size={17} color={colors.orange} />
      <Pressable accessibilityRole="button" accessibilityLabel={text} accessibilityHint="Opens that chat" testID="waiting-banner-open" onPress={() => onOpen(first.id)} style={({ pressed }) => [styles.open, { opacity: pressed ? 0.68 : 1 }]}>
        <Text style={[styles.text, { color: colors.text }]} numberOfLines={2}>{text}</Text>
      </Pressable>
      <IconButton icon={X} size={15} onPress={() => setHidden(key)} label="Hide" testID="waiting-banner-dismiss" />
    </View>
  </View>
}

const styles = StyleSheet.create({
  slot: { flexShrink: 0, paddingHorizontal: 12, paddingTop: 8 },
  banner: { width: '100%', minHeight: 44, maxWidth: 740, alignSelf: 'center', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 7 },
  open: { flex: 1, minWidth: 0, paddingVertical: 6 },
  text: { fontSize: 12, fontWeight: '600' },
})
