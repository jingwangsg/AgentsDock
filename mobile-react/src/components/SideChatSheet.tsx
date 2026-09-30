import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ArrowUp, MessageCircleQuestion, Square, Trash2 } from 'lucide-react-native'
import { sideChatAvailable, sideChatErrorMessage, sideChatLimit, subscribeSideChatChanged, type SyncedSideChat } from '../lib/side-chat'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { Text, TextInput } from './AppText'
import { MarkdownContent } from './MarkdownContent'
import { IconButton, SheetCloseButton } from './ui'

// A draft outlives the sheet, as on the desktop.
const drafts = new Map<string, string>()

/** The composer's side chat button, shown where the server and provider support a synced side chat. */
export function SideChatButton({ sessionId, onPress }: { sessionId: string; onPress: () => void }) {
  const backend = useAppStore(state => state.sessions.find(value => value.id === sessionId)?.backend)
  const available = useAppStore(state => backend !== undefined && sideChatAvailable(state.health, backend))
  if (!available) return null
  // A 44 pt target on the 30 pt folder row: the margins keep the row's height.
  return <View style={styles.button}>
    <IconButton icon={MessageCircleQuestion} size={17} label="Side chat" testID="composer-side-chat" onPress={onPress} />
  </View>
}

/** Side questions about a chat, answered in a separate native conversation; the main agent never sees them. */
export function SideChatSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const colors = usePalette()
  const title = useAppStore(state => state.sessions.find(value => value.id === sessionId)?.title ?? '')
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const live = useAppStore(state => state.syncSessionId === sessionId && state.syncStatus === 'live')
  const limit = useAppStore(state => sideChatLimit(state.health))
  const fontScale = useAppStore(state => state.fontScale)
  const draftKey = `${activeProfileId}:${sessionId}`
  const [draft, setDraftState] = useState(() => drafts.get(draftKey) ?? '')
  const [chat, setChat] = useState<SyncedSideChat | null>(null)
  const [sending, setSending] = useState<{ requestId: string; question: string } | null>(null)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revision = useRef(-1)
  const history = useRef<ScrollView>(null)

  const setDraft = (value: string) => { drafts.set(draftKey, value); setDraftState(value) }
  // A result from a previous server, connection or chat is dropped, as in the usage panel.
  const scopeIsCurrent = (connection: typeof client) => {
    const store = useAppStore.getState()
    return client === connection && !connection.isDisposed && connection.isValidated
      && store.activeProfileId === activeProfileId && store.profileGeneration === profileGeneration
      && store.selectedSessionId === sessionId
  }
  const apply = (next: SyncedSideChat) => {
    if (next.revision < revision.current) return
    revision.current = next.revision
    setChat(next)
  }
  const read = () => {
    const connection = client
    void connection.readSideChat(sessionId)
      .then(next => { if (scopeIsCurrent(connection)) { apply(next); setError(null) } })
      .catch(() => { if (scopeIsCurrent(connection)) setError('Could not sync side chat. Try again.') })
  }
  // Opening, and every change of the live stream (a reconnect may have missed a push), reads the server copy.
  useEffect(() => { if (connected) read() }, [connected, live, activeProfileId, profileGeneration, sessionId])
  useEffect(() => subscribeSideChatChanged(notification => {
    if (notification.profileId === activeProfileId && notification.profileGeneration === profileGeneration
      && notification.sessionId === sessionId && notification.revision > revision.current) read()
  }), [activeProfileId, profileGeneration, sessionId])

  const running = chat?.exchanges.find(exchange => exchange.status === 'running')
  const question = draft.trim()
  const length = Array.from(question).length
  const canSend = connected && chat !== null && !running && !sending && !clearing && length > 0 && length <= limit
  const send = () => {
    if (!canSend) return
    const connection = client
    const requestId = `side-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    setSending({ requestId, question })
    setDraft('')
    setError(null)
    void connection.submitSideChat(sessionId, {
      request_id: requestId, question, side_chat_id: chat.side_chat_id, after_request_id: chat.last_request_id ?? undefined,
    })
      .then(next => { if (scopeIsCurrent(connection)) apply(next) })
      .catch(async cause => {
        // The acknowledgement can be lost after the server accepted the question: read it back instead of
        // resending. Without a server copy (or a connection to check) the question returns to the draft.
        const next = scopeIsCurrent(connection) ? await connection.readSideChat(sessionId).catch(() => null) : null
        if (next && scopeIsCurrent(connection)) apply(next)
        if (next?.exchanges.some(exchange => exchange.request_id === requestId)) return
        if (!drafts.get(draftKey)) setDraft(question)
        setError(sideChatErrorMessage(cause))
      })
      .finally(() => setSending(null))
  }
  const stop = () => {
    if (!running) return
    const connection = client
    void connection.stopSideChat(sessionId, running.request_id)
      .then(next => { if (scopeIsCurrent(connection)) apply(next) })
      .catch(() => { if (scopeIsCurrent(connection)) setError('Could not confirm cancellation. Check the response and try Stop again.') })
  }
  const clear = () => {
    if (!chat || clearing) return
    const connection = client
    setClearing(true)
    setDraft('')
    void connection.clearSideChat(sessionId, chat.side_chat_id)
      .then(next => { if (scopeIsCurrent(connection)) { apply(next); setError(null) } })
      .catch(cause => { if (scopeIsCurrent(connection)) setError(sideChatErrorMessage(cause)) })
      .finally(() => setClearing(false))
  }

  const questionBubble = (text: string) => <View style={[styles.question, { backgroundColor: colors.raised }]}>
    <Text selectable style={[styles.body, { color: colors.text }]}>{text}</Text>
  </View>
  const status = (text: string, color = colors.muted) => <Text style={[styles.status, { color }]}>{text}</Text>
  // A push-triggered read can list the question before its POST returns.
  const pendingBubble = sending && !chat?.exchanges.some(exchange => exchange.request_id === sending.requestId)
  return <Modal visible animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={onClose}>
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      {/* keyboard-controller follows the IME inside a Modal's own window, as in the canvas sheet. */}
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <MessageCircleQuestion size={20} color={colors.blue} />
          <View style={styles.titleWrap}>
            <Text style={[styles.title, { color: colors.text }]}>Side chat</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>About {title}</Text>
          </View>
          <IconButton icon={Trash2} label="Clear side chat" testID="side-chat-clear" disabled={!chat || !connected || Boolean(sending) || clearing} onPress={clear} />
          <SheetCloseButton label="Close side chat" testID="side-chat-close" onPress={onClose} />
        </View>
        <ScrollView ref={history} style={styles.fill} contentContainerStyle={styles.history} keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => history.current?.scrollToEnd({ animated: false })}>
          {!chat && connected && !error ? <View style={styles.row}><ActivityIndicator color={colors.muted} />{status('Loading side chat…')}</View> : null}
          {chat && !chat.exchanges.length && !sending ? status('Ask about this conversation. Your main task keeps running.') : null}
          {chat?.exchanges.map(exchange => <View key={exchange.request_id} style={styles.exchange}>
            {questionBubble(exchange.question)}
            {exchange.answer ? <MarkdownContent value={exchange.answer} fontScale={fontScale} sourceSessionId={sessionId} /> : null}
            {exchange.status === 'running' ? status('Answering…')
              : exchange.status === 'cancelled' ? status('Response cancelled.')
                : exchange.status === 'failed' || exchange.status === 'interrupted'
                  ? status(sideChatErrorMessage(exchange.error ?? `side_question_${exchange.status}`), colors.red) : null}
          </View>)}
          {pendingBubble ? <View style={styles.exchange}>{questionBubble(sending.question)}{status('Answering…')}</View> : null}
        </ScrollView>
        <View style={styles.footer}>
          {!connected ? status('Connect to the server to ask a side question.') : null}
          {error ? <View style={styles.row}>
            <Text accessibilityRole="alert" style={[styles.status, styles.grow, { color: colors.red }]}>{error}</Text>
            {!chat ? <Pressable accessibilityRole="button" onPress={read} hitSlop={8}><Text style={[styles.retry, { color: colors.blue }]}>Retry</Text></Pressable> : null}
          </View> : null}
          {length > limit ? status(`${length} / ${limit} characters`, colors.red) : null}
          <View style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <TextInput testID="side-chat-input" accessibilityLabel="Side message" value={draft} onChangeText={setDraft} multiline
              editable={connected && chat !== null} placeholder="Ask a side question…" placeholderTextColor={colors.muted}
              style={[styles.input, { color: colors.text }]} />
            {running
              ? <IconButton icon={Square} label="Cancel side response" testID="side-chat-stop" onPress={stop} />
              : <IconButton icon={ArrowUp} label="Send side message" testID="side-chat-send" disabled={!canSend} onPress={send} />}
          </View>
          {status('Only in this side chat · not sent to the main agent')}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>
}

const styles = StyleSheet.create({
  button: { marginVertical: -7 },
  fill: { flex: 1 },
  grow: { flex: 1, minWidth: 0 },
  header: { minHeight: 64, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 9, borderBottomWidth: StyleSheet.hairlineWidth },
  titleWrap: { flex: 1, minWidth: 0 },
  title: { fontSize: 17, fontWeight: '800' },
  subtitle: { fontSize: 12, marginTop: 2 },
  history: { padding: 14, gap: 16 },
  exchange: { gap: 8 },
  question: { alignSelf: 'flex-end', maxWidth: '88%', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  body: { fontSize: 15, lineHeight: 21 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  status: { fontSize: 12.5, lineHeight: 18 },
  retry: { fontSize: 13, fontWeight: '700' },
  footer: { paddingHorizontal: 12, paddingBottom: 8, gap: 6 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingLeft: 12 },
  input: { flex: 1, minHeight: 44, maxHeight: 160, fontSize: 15, paddingVertical: 11 },
})
