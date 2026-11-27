// Comment threads under a Canvas: port of electron/src/renderer/src/components/CanvasCommentThreads.tsx.
import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { Check, RotateCcw, Trash2, X } from 'lucide-react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { fonts } from '../lib/typography'
import { usePalette } from '../theme'
import type { CanvasCommentAnchor, CanvasCommentMessage, CanvasCommentMode, CanvasCommentReply, CanvasCommentThread } from '../types'
import { Text, TextInput } from './AppText'
import { MarkdownContent } from './MarkdownContent'
import { IconButton } from './ui'

/**
 * "loss-table · 1.92" or `<td> 1.92` — how a thread names the element it is about. The id is
 * the nearest data-canvas-id, often a whole section, so the element's own text follows it.
 * Same format as the server's display prompt (agentsdock_canvas.comment_prompt).
 */
export function canvasAnchorLabel(anchor: Pick<CanvasCommentAnchor, 'canvas_id' | 'tag' | 'text'>): string {
  const text = anchor.text.replace(/\s+/g, ' ').trim().slice(0, 40)
  if (anchor.canvas_id) return text ? `${anchor.canvas_id} · ${text}` : anchor.canvas_id
  return `<${anchor.tag}> ${text}`.trim()
}

/** Ask/Edit submit pair shared by the new-comment composer and each thread's reply box. */
export function CanvasCommentSubmit({ disabled, onSubmit }: { disabled: boolean; onSubmit: (mode: CanvasCommentMode) => void }) {
  const colors = usePalette()
  return <View style={styles.submit}>
    <Pressable testID="canvas-comment-ask" accessibilityRole="button" accessibilityLabel="Ask" accessibilityHint="The agent answers under this comment and leaves the canvas unchanged" accessibilityState={{ disabled }} disabled={disabled} onPress={() => onSubmit('ask')}
      style={({ pressed }) => [styles.submitButton, { backgroundColor: colors.raised, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}>
      <Text style={[styles.submitText, { color: colors.text }]}>Ask</Text>
    </Pressable>
    <Pressable testID="canvas-comment-edit" accessibilityRole="button" accessibilityLabel="Edit" accessibilityHint="The agent changes the canvas to do this" accessibilityState={{ disabled }} disabled={disabled} onPress={() => onSubmit('edit')}
      style={({ pressed }) => [styles.submitButton, { backgroundColor: colors.blue, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}>
      <Text style={[styles.submitText, { color: colors.textOnAccent }]}>Edit</Text>
    </Pressable>
  </View>
}

/** What a reply shows besides an answer: that it is still coming, or how it ended. Null for a completed answer. */
function replyStatus(reply: CanvasCommentReply | null): string | null {
  if (!reply || reply.status === 'queued') return 'Waiting for the agent…'
  if (reply.status === 'running') return 'The agent is working on it…'
  if (reply.status === 'cancelled') return 'Removed from the queue'
  if (reply.status === 'done') return null
  return reply.status === 'stopped' ? 'Stopped' : 'The reply failed'
}

function Reply({ message }: { message: CanvasCommentMessage }) {
  const colors = usePalette()
  const reply = message.reply
  const status = <Text style={[styles.status, { color: colors.muted }]}>{replyStatus(reply)}</Text>
  if (!reply || reply.status === 'queued' || reply.status === 'running' || reply.status === 'cancelled') return status
  return <View style={[styles.reply, { borderColor: colors.border }]}>
    {reply.status !== 'done' ? status : null}
    {reply.text ? <MarkdownContent value={reply.text} compact /> : null}
  </View>
}

export function CanvasCommentThreads({ threads, activeId, located, onActivate, onDeactivate, onReply, onStatus, onDelete }: {
  threads: CanvasCommentThread[]
  activeId: string | null
  /** Threads whose element exists in the rendered revision; null until the page reported. */
  located: ReadonlySet<string> | null
  onActivate: (id: string) => void
  onDeactivate: () => void
  onReply: (thread: CanvasCommentThread, mode: CanvasCommentMode, body: string) => Promise<boolean>
  onStatus: (thread: CanvasCommentThread, status: CanvasCommentThread['status']) => void
  onDelete: (thread: CanvasCommentThread) => void
}) {
  const colors = usePalette()
  // Per thread, so switching threads neither carries nor drops a half-written reply.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  // A new comment or a tapped pin makes a thread active; bring it into view.
  const scrollRef = useRef<ScrollView>(null)
  const offsets = useRef(new Map<string, number>())
  useEffect(() => {
    const y = activeId ? offsets.current.get(activeId) : undefined
    if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true })
  }, [activeId, threads])
  // Numbers follow creation order and match the pins, so a resolved thread keeps its number.
  const numbered = threads.map((thread, index) => ({ thread, number: index + 1 }))
  const open = numbered.filter(item => item.thread.status === 'open')
  const resolved = numbered.filter(item => item.thread.status === 'resolved')

  const renderThread = ({ thread, number }: { thread: CanvasCommentThread; number: number }) => {
    const active = thread.id === activeId
    const draft = drafts[thread.id] ?? ''
    // Only the active thread shows its messages. The header of another one says that a reply is still coming, or how its latest reply ended.
    const noted = active ? undefined : thread.messages.find(message => !message.reply || message.reply.status === 'queued' || message.reply.status === 'running') ?? thread.messages.at(-1)
    const status = noted && replyStatus(noted.reply)
    return <View key={thread.id} testID={`canvas-comment-thread-${number}`} onLayout={event => {
      const y = event.nativeEvent.layout.y
      const before = offsets.current.get(thread.id)
      // The effect above scrolled to where this thread was. The active thread above it collapsed in the same render, which moved this one up.
      if (active && before !== undefined && before !== y) scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true })
      offsets.current.set(thread.id, y)
    }} style={[styles.thread, { borderColor: active ? colors.blue : colors.border, backgroundColor: colors.background, opacity: thread.status === 'resolved' ? 0.7 : 1 }]}>
      <View style={styles.threadHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Show the element for comment ${number}`} accessibilityState={{ expanded: active }} onPress={() => onActivate(thread.id)} style={styles.anchor}>
          <View style={[styles.number, { backgroundColor: colors.blue }]}><Text style={[styles.numberText, { color: colors.textOnAccent }]}>{number}</Text></View>
          <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>{canvasAnchorLabel(thread.anchor)}</Text>
        </Pressable>
        {located && !located.has(thread.id) ? <Text style={[styles.status, { color: colors.muted }]}>Not in this revision</Text> : null}
        {status ? <Text style={[styles.status, { color: colors.muted }]}>{status}</Text> : null}
        {thread.status === 'open'
          ? <IconButton icon={Check} size={16} touchSize={36} label="Resolve" onPress={() => onStatus(thread, 'resolved')} />
          : <IconButton icon={RotateCcw} size={16} touchSize={36} label="Reopen" onPress={() => onStatus(thread, 'open')} />}
        <IconButton icon={Trash2} size={16} touchSize={36} label="Delete thread" onPress={() => onDelete(thread)} />
        {active ? <IconButton icon={X} size={16} touchSize={36} label="Collapse thread" onPress={() => {
          // Collapsing removes the reply input, and Android keeps the keyboard of an input removed while it has the focus.
          dismissAppKeyboard()
          onDeactivate()
        }} /> : null}
      </View>
      {active ? thread.messages.map(message => <View key={message.id} style={styles.exchange}>
        <View style={styles.message}>
          <Text style={[styles.mode, { color: message.mode === 'edit' ? colors.blue : colors.muted, backgroundColor: colors.raised }]}>{message.mode === 'ask' ? 'Ask' : 'Edit'}</Text>
          <Text selectable style={[styles.body, { color: colors.text }]}>{message.body}</Text>
        </View>
        <Reply message={message} />
      </View>) : null}
      {active ? <View style={styles.replyBox}>
        <TextInput
          testID="canvas-comment-reply-input"
          value={draft}
          onChangeText={text => setDrafts(current => ({ ...current, [thread.id]: text }))}
          placeholder="Reply…"
          placeholderTextColor={colors.muted}
          multiline
          style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
        />
        <CanvasCommentSubmit disabled={!draft.trim() || sending} onSubmit={mode => {
          setSending(true)
          void onReply(thread, mode, draft.trim())
            .then(sent => { if (sent) setDrafts(current => ({ ...current, [thread.id]: '' })) })
            .finally(() => setSending(false))
        }} />
      </View> : null}
    </View>
  }

  return <ScrollView ref={scrollRef} testID="canvas-comments" style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.surface }]} contentContainerStyle={styles.panelContent} keyboardShouldPersistTaps="handled">
    {!threads.length ? <Text style={[styles.status, { color: colors.muted }]}>No comments yet. Tap the comment button, then an element, to comment on it.</Text> : null}
    {open.map(renderThread)}
    {resolved.length ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: showResolved }} onPress={() => setShowResolved(value => !value)} style={styles.resolvedToggle}>
      <Text style={[styles.status, { color: colors.muted }]}>Resolved ({resolved.length})</Text>
    </Pressable> : null}
    {showResolved ? resolved.map(renderThread) : null}
  </ScrollView>
}

const styles = StyleSheet.create({
  panel: { flexGrow: 0, maxHeight: '45%', borderTopWidth: StyleSheet.hairlineWidth },
  panelContent: { padding: 10, gap: 8 },
  thread: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 8, gap: 6 },
  threadHeader: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  anchor: { flex: 1, minWidth: 0, minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 8 },
  number: { minWidth: 22, height: 22, paddingHorizontal: 6, borderTopLeftRadius: 11, borderTopRightRadius: 11, borderBottomRightRadius: 11, borderBottomLeftRadius: 2, alignItems: 'center', justifyContent: 'center' },
  numberText: { fontSize: 11, fontWeight: '800' },
  label: { flex: 1, fontFamily: fonts.mono, fontSize: 12 },
  exchange: { gap: 4 },
  message: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  mode: { fontSize: 11, fontWeight: '800', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, overflow: 'hidden' },
  body: { flex: 1, fontSize: 14, lineHeight: 20 },
  reply: { paddingLeft: 10, borderLeftWidth: 2 },
  status: { fontSize: 12 },
  replyBox: { gap: 6 },
  input: { minHeight: 40, maxHeight: 120, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  submit: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  submitButton: { minHeight: 36, minWidth: 64, borderRadius: 8, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  submitText: { fontSize: 13, fontWeight: '800' },
  resolvedToggle: { minHeight: 32, justifyContent: 'center' },
})
