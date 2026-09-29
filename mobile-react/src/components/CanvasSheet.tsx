// Page sheet that shows one chat's Canvas reports: port of the Electron CanvasPane, with
// element comments (persistent threads) and an editable source on servers that offer them.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'
import { ChevronDown, ChevronUp, MessageSquare, MessageSquarePlus, RefreshCw, Search, X } from 'lucide-react-native'
import { MobileCodeEditor, type MobileCodeEditorController } from '../editor/MobileCodeEditor'
import {
  buildCanvasPage,
  canvasCommentPinsScript,
  canvasFindScript,
  canvasFocusCommentScript,
  canvasSelectingScript,
  parseCanvasPageMessage,
  type CanvasCommentPin,
  type CanvasHostTheme,
  type CanvasSelectedElement,
} from '../lib/canvas-page'
import { interactiveClientCapabilities } from '../lib/chat-references'
import { fonts } from '../lib/typography'
import { client, useAppStore } from '../store/useAppStore'
import { useAppColorScheme, usePalette } from '../theme'
import type { CanvasCommentMode, CanvasCommentThread, CanvasRecord, CanvasSummary, Event } from '../types'
import { Text, TextInput } from './AppText'
import { CanvasCommentSubmit, CanvasCommentThreads, canvasAnchorLabel } from './CanvasCommentThreads'
import { IconButton, Loading, SheetCloseButton } from './ui'

const STATE_SAVE_DELAY_MS = 400
// Opaque origin: the page has no server to talk to, and its CSP allows data: scripts only.
const CANVAS_PAGE_BASE_URL = 'about:blank'
const EMPTY_EVENTS: Event[] = []
// The server's 409 text for a source save that lost to a newer revision (agentsdock_canvas.RevisionConflict).
const REVISION_CONFLICT = /changed since it was opened/
const errorText = (caught: unknown) => caught instanceof Error ? caught.message : String(caught)

/** shell.html and vendor.js per runtime version: 650 KB that every canvas on a server shares. */
const runtimeAssets = new Map<string, Promise<{ shell: string; vendor: string }>>()
function loadRuntimeAssets(version: string): Promise<{ shell: string; vendor: string }> {
  let pending = runtimeAssets.get(version)
  if (!pending) {
    pending = Promise.all([client.canvasRuntimeAsset('shell.html'), client.canvasRuntimeAsset('vendor.js')])
      .then(([shell, vendor]) => ({ shell, vendor }))
    // A failed download must not be served to the next open.
    pending.catch(() => runtimeAssets.delete(version))
    runtimeAssets.set(version, pending)
  }
  return pending
}

function lastRewindSeq(events: readonly Event[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === 'history_rewound') return events[index].seq
  }
  return null
}

export function CanvasSheet({ sessionId, name, onClose }: { sessionId: string; name: string | null; onClose: () => void }) {
  const colors = usePalette()
  return <Modal visible={name !== null} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={onClose}>
    <SafeAreaView style={[styles.fill, { backgroundColor: colors.background }]} edges={['bottom']}>
      <View style={styles.grabber} />
      {/* Keyed on the requested name: a link to another canvas replaces the body, and unmounting flushes its pending state. */}
      {name !== null ? <CanvasSheetBody key={name} sessionId={sessionId} initialName={name} onClose={onClose} /> : null}
    </SafeAreaView>
  </Modal>
}

function CanvasSheetBody({ sessionId, initialName, onClose }: { sessionId: string; initialName: string; onClose: () => void }) {
  const colors = usePalette()
  const scheme = useAppColorScheme()
  const [name, setName] = useState(initialName)
  const [canvases, setCanvases] = useState<CanvasSummary[]>([])
  const [record, setRecord] = useState<CanvasRecord | null>(null)
  const [runtime, setRuntime] = useState<{ version: string; shell: string; vendor: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findResult, setFindResult] = useState<{ total: number; active: number }>({ total: 0, active: 0 })
  const canvasCapability = useAppStore(state => state.health?.capabilities?.canvas_v1)
  // Older servers keep the read-only source and no comments.
  const commentsAvailable = canvasCapability?.comments === true
  const sourceEditable = canvasCapability?.source_edit === true
  const [selecting, setSelecting] = useState(false)
  const [selection, setSelection] = useState<CanvasSelectedElement | null>(null)
  const [commentText, setCommentText] = useState('')
  const [threads, setThreads] = useState<CanvasCommentThread[]>([])
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [located, setLocated] = useState<ReadonlySet<string> | null>(null)
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  /** Unsaved source edits and the revision they started from; null while the editor shows the saved source. */
  const [sourceDraft, setSourceDraft] = useState<{ text: string; baseRevision: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const editorRef = useRef<MobileCodeEditorController>(null)
  // The editor replaces its document when `value` changes; while a draft exists it keeps the
  // source the draft started from, so a reload after an agent edit cannot wipe the typing.
  const editorDocument = useRef('')
  const webViewRef = useRef<WebView>(null)
  /** Full persistent state of the canvas on screen; the page reports one key at a time and the server replaces the file wholesale. */
  const stateRef = useRef<Record<string, unknown>>({})
  /** Snapshot awaiting its debounced PUT. It carries its own name so switching canvases cannot redirect it. */
  const pendingSave = useRef<{ name: string; state: Record<string, unknown> } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadGeneration = useRef(0)

  const flushSave = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const pending = pendingSave.current
    pendingSave.current = null
    if (!pending) return
    try {
      await client.putCanvasState(sessionId, pending.name, pending.state)
    } catch (caught) {
      // pageError renders above the WebView; `error` would replace it and destroy the live canvas.
      setPageError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [sessionId])

  useEffect(() => {
    // The server compiles on first read, long enough for the user to switch canvases meanwhile; a stale response must not land on the new name.
    const generation = ++loadGeneration.current
    const live = () => generation === loadGeneration.current
    void (async () => {
      setError(null)
      try {
        // A reload must read back the last edit, not the state the server held before the pending PUT.
        await flushSave()
        const [list, current] = await Promise.all([client.listCanvases(sessionId), client.getCanvas(sessionId, name)])
        if (!live()) return
        setCanvases(list.canvases)
        setRecord(current)
        stateRef.current = current.state ?? {}
        const version = current.runtime_version
        if (current.javascript && version) {
          const assets = await loadRuntimeAssets(version)
          // Same version → same object, so the page is not rebuilt (and reloaded) a second time.
          if (live()) setRuntime(previous => previous?.version === version ? previous : { version, ...assets })
        }
      } catch (caught) {
        if (!live()) return
        setRecord(null)
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
  }, [flushSave, name, reloadToken, sessionId])

  // A history rewind deletes the canvases it covers: re-list, and leave when the open one is gone.
  const rewoundSeq = useAppStore(state => lastRewindSeq(state.snapshots[sessionId]?.events ?? EMPTY_EVENTS))
  const seenRewind = useRef(rewoundSeq)
  useEffect(() => {
    if (seenRewind.current === rewoundSeq) return
    seenRewind.current = rewoundSeq
    void client.listCanvases(sessionId)
      .then(list => list.canvases.some(canvas => canvas.name === name))
      // Unknown → keep the sheet; the reload surfaces the error itself.
      .catch(() => true)
      .then(present => { if (present) setReloadToken(token => token + 1); else onClose() })
  }, [name, onClose, rewoundSeq, sessionId])

  // Flush when the sheet switches canvases and when it unmounts, so the last reported change is not dropped.
  useEffect(() => () => { void flushSave() }, [flushSave, name])

  const loadComments = useCallback(async () => {
    if (!commentsAvailable) return
    try {
      setThreads((await client.listCanvasComments(sessionId, name)).threads)
    } catch (caught) {
      setCommentError(errorText(caught))
    }
  }, [commentsAvailable, name, sessionId])
  useEffect(() => {
    setThreads([])
    setActiveThread(null)
    setLocated(null)
    void loadComments()
  }, [loadComments])

  // A turn starting or ending can answer a comment or edit this canvas: refresh the threads,
  // and reload only when the canvas has a new revision (a reload resets the page's own state).
  const running = useAppStore(state => state.activeSessionIds.has(sessionId))
  const seenRunning = useRef(running)
  const revisionLive = useRef<number | null>(null)
  revisionLive.current = record?.revision ?? null
  useEffect(() => {
    if (seenRunning.current === running) return
    seenRunning.current = running
    void loadComments()
    void client.listCanvases(sessionId)
      .then(list => list.canvases.find(canvas => canvas.name === name))
      .then(current => { if (current && current.revision !== revisionLive.current) setReloadToken(token => token + 1) })
      .catch(() => undefined)
  }, [loadComments, name, running, sessionId])

  // Pins for the open threads, numbered like the list; re-injected whenever the page (re)loads.
  const pins = useMemo<CanvasCommentPin[]>(() => threads.flatMap((thread, index) => thread.status === 'open' ? [{
    id: thread.id, number: index + 1, canvasId: thread.anchor.canvas_id, tag: thread.anchor.tag, text: thread.anchor.text, label: canvasAnchorLabel(thread.anchor),
  }] : []), [threads])
  const injectPins = useCallback(() => {
    webViewRef.current?.injectJavaScript(canvasCommentPinsScript(pins, activeThread))
  }, [activeThread, pins])
  useEffect(() => { injectPins() }, [injectPins])

  const receive = (event: WebViewMessageEvent) => {
    const message = parseCanvasPageMessage(event.nativeEvent.data)
    if (!message) return
    switch (message.kind) {
      case 'ready':
        setPageError(null)
        injectPins()
        break
      case 'selection':
        if (message.elements.length) setSelection(message.elements[0])
        if (message.complete) setSelecting(false)
        break
      case 'comment-open':
        setCommentsOpen(true)
        setActiveThread(message.id)
        break
      case 'comment-anchors':
        setLocated(new Set(message.located))
        break
      case 'state':
        stateRef.current = { ...stateRef.current, [message.key]: message.value }
        pendingSave.current = { name, state: stateRef.current }
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => { void flushSave() }, STATE_SAVE_DELAY_MS)
        break
      case 'error':
        setPageError(message.error)
        break
      case 'find-result':
        setFindResult({ total: message.total, active: message.active })
        break
      case 'link':
        if (/^https?:\/\//i.test(message.url)) void Linking.openURL(message.url).catch(() => undefined)
        break
    }
  }

  const injectFind = (query: string, options: { forward?: boolean; findNext?: boolean } = {}) => {
    webViewRef.current?.injectJavaScript(canvasFindScript(query, options))
  }
  const closeFind = () => {
    setFindOpen(false)
    setFindResult({ total: 0, active: 0 })
    injectFind('')
  }

  // Zed's editor.background is `surface` here (theme.ts), the same token the desktop pane hands the runtime.
  const theme = useMemo<CanvasHostTheme>(
    () => ({ background: colors.surface, foreground: colors.text, muted: colors.muted, border: colors.border, accent: colors.blue, kind: scheme }),
    [colors, scheme],
  )
  const compiled = record && !record.diagnostics && record.javascript ? record : null
  const source = useMemo(() => {
    if (!compiled || !runtime || runtime.version !== compiled.runtime_version) return null
    // State is read at build time: a theme switch or reload keeps edits made after the record was fetched.
    return { html: buildCanvasPage({ shell: runtime.shell, vendor: runtime.vendor, javascript: compiled.javascript, state: stateRef.current, theme }), baseUrl: CANVAS_PAGE_BASE_URL }
  }, [compiled, runtime, theme])

  const toggleSelecting = () => {
    const next = !selecting
    setSelecting(next)
    if (!next) setSelection(null)
    webViewRef.current?.injectJavaScript(canvasSelectingScript(next))
  }
  const clearComposer = () => {
    setSelection(null)
    setCommentText('')
    webViewRef.current?.injectJavaScript(canvasSelectingScript(false))
  }
  const commentInput = (mode: CanvasCommentMode, body: string) => {
    const state = useAppStore.getState()
    const session = state.sessions.find(value => value.id === sessionId)
    // Same capabilities as a composer message, so the comment's turn uses the same transport.
    return { mode, body, revision: record?.revision ?? 0, client_capabilities: interactiveClientCapabilities(session, state.health) }
  }
  /** Ask answers in the chat and leaves the canvas alone; Edit asks the agent to change it. */
  const submitComment = async (mode: CanvasCommentMode) => {
    if (!record || !selection || !commentText.trim()) return
    setCommentBusy(true)
    setCommentError(null)
    try {
      const { thread } = await client.createCanvasComment(sessionId, name, {
        canvas_id: selection.id, tag: selection.tag, text: selection.text.slice(0, 400), html: selection.html.slice(0, 2000),
      }, commentInput(mode, commentText.trim()))
      setThreads(current => [...current, thread])
      setActiveThread(thread.id)
      setCommentsOpen(true)
      clearComposer()
    } catch (caught) {
      setCommentError(errorText(caught))
    } finally {
      setCommentBusy(false)
    }
  }
  const replaceThread = (thread: CanvasCommentThread) => setThreads(current => current.map(item => item.id === thread.id ? thread : item))
  const replyToThread = async (thread: CanvasCommentThread, mode: CanvasCommentMode, body: string): Promise<boolean> => {
    setCommentError(null)
    try {
      replaceThread((await client.replyCanvasComment(sessionId, name, thread.id, commentInput(mode, body))).thread)
      return true
    } catch (caught) {
      setCommentError(errorText(caught))
      return false
    }
  }
  const setThreadStatus = (thread: CanvasCommentThread, status: CanvasCommentThread['status']) => {
    void client.setCanvasCommentStatus(sessionId, name, thread.id, status)
      .then(result => replaceThread(result.thread), caught => setCommentError(errorText(caught)))
  }
  const deleteThread = (thread: CanvasCommentThread) => {
    Alert.alert('Delete this comment thread?', 'Its messages stay in the chat.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => {
        void client.deleteCanvasComment(sessionId, name, thread.id)
          .then(() => setThreads(current => current.filter(item => item.id !== thread.id)), caught => setCommentError(errorText(caught)))
      } },
    ])
  }
  const activateThread = (id: string) => {
    setActiveThread(id)
    setShowSource(false)
    webViewRef.current?.injectJavaScript(canvasFocusCommentScript(id))
  }

  const saveSource = async (overwrite = false): Promise<void> => {
    if (!sourceDraft || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      // Overwriting means saving over whatever revision is current now, after the user confirmed.
      const base = overwrite ? (await client.getCanvas(sessionId, name)).revision : sourceDraft.baseRevision
      const next = await client.putCanvasSource(sessionId, name, sourceDraft.text, base)
      setRecord(next)
      stateRef.current = next.state ?? {}
      setSourceDraft(null)
      editorRef.current?.markClean(next.source)
    } catch (caught) {
      const message = errorText(caught)
      if (!overwrite && REVISION_CONFLICT.test(message)) {
        Alert.alert('The canvas changed', 'It changed after you started editing (usually the agent). Replace it with your version?', [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Replace', style: 'destructive', onPress: () => { void saveSource(true) } },
        ])
      } else {
        setSaveError(message)
      }
    } finally {
      setSaving(false)
    }
  }
  const discardSource = () => {
    setSourceDraft(null)
    setSaveError(null)
    if (record) editorRef.current?.replaceDocument(record.source, { clean: true })
  }
  const fixWithAgent = () => {
    if (!record?.diagnostics) return
    const state = useAppStore.getState()
    void state.sendPrompt(false, state.profileGeneration, sessionId, {
      consumeComposer: false,
      promptOverride: [`The canvas ${record.path} fails to compile:`, '', record.diagnostics, '', 'Fix the canvas source so it compiles, then run the canvas check.'].join('\n'),
    })
    onClose()
  }

  const switchTo = (next: string) => {
    if (next === name) return
    setRecord(null)
    setPageError(null)
    setShowSource(false)
    setSourceDraft(null)
    setSelection(null)
    setSelecting(false)
    setName(next)
  }
  const showSourceAction = { label: 'Show source', onPress: () => setShowSource(true) }

  return <>
    <View style={styles.top}>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>Canvas · {name}</Text>
      {compiled && !showSource ? <IconButton icon={Search} size={16} selected={findOpen} label="Find in canvas" testID="canvas-find" onPress={() => (findOpen ? closeFind() : setFindOpen(true))} /> : null}
      {commentsAvailable && compiled && !showSource ? <IconButton icon={MessageSquarePlus} size={16} selected={selecting} label="Comment on an element" testID="canvas-comment-select" onPress={toggleSelecting} /> : null}
      {commentsAvailable ? <Pressable testID="canvas-comments-toggle" accessibilityRole="button" accessibilityLabel={`Comments, ${pins.length} open`} accessibilityState={{ selected: commentsOpen }} onPress={() => setCommentsOpen(value => !value)}
        style={({ pressed }) => [styles.commentsToggle, { backgroundColor: commentsOpen ? colors.raised : 'transparent', opacity: pressed ? 0.7 : 1 }]}>
        <MessageSquare size={16} color={commentsOpen ? colors.text : colors.muted} />
        {pins.length ? <Text style={[styles.commentCount, { color: colors.textOnAccent, backgroundColor: colors.blue }]}>{pins.length}</Text> : null}
      </Pressable> : null}
      <IconButton icon={RefreshCw} size={16} label="Reload canvas" testID="canvas-reload" onPress={() => { setPageError(null); setReloadToken(token => token + 1) }} />
      <SheetCloseButton onPress={onClose} label="Close canvas" testID="canvas-close" />
    </View>
    {canvases.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.switcher} contentContainerStyle={styles.switcherContent}>
      {canvases.map(item => {
        const selected = item.name === name
        return <Pressable key={item.name} accessibilityRole="button" accessibilityLabel={`Show canvas ${item.name}`} accessibilityState={{ selected }} onPress={() => switchTo(item.name)} style={[styles.chip, { borderColor: selected ? colors.blue : colors.border, backgroundColor: selected ? `${colors.blue}1A` : colors.surface }]}>
          <Text style={[styles.chipText, { color: selected ? colors.blue : colors.text }]} numberOfLines={1}>{item.name}</Text>
        </Pressable>
      })}
    </ScrollView> : null}
    {findOpen && compiled && !showSource ? <View style={[styles.findBar, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Search size={15} color={colors.muted} />
      <TextInput
        testID="canvas-find-input"
        style={[styles.findInput, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]}
        value={findQuery}
        onChangeText={text => { setFindQuery(text); injectFind(text) }}
        onSubmitEditing={() => injectFind(findQuery, { findNext: true, forward: true })}
        placeholder="Find in canvas"
        placeholderTextColor={colors.muted}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />
      <Text testID="canvas-find-count" style={[styles.findCount, { color: colors.muted }]}>{findQuery ? `${findResult.active}/${findResult.total}` : ''}</Text>
      <IconButton icon={ChevronUp} size={18} disabled={findResult.total === 0} label="Previous match" testID="canvas-find-prev" onPress={() => injectFind(findQuery, { findNext: true, forward: false })} />
      <IconButton icon={ChevronDown} size={18} disabled={findResult.total === 0} label="Next match" testID="canvas-find-next" onPress={() => injectFind(findQuery, { findNext: true, forward: true })} />
      <IconButton icon={X} size={18} label="Close find" testID="canvas-find-close" onPress={closeFind} />
    </View> : null}
    {/* keyboard-controller follows the IME inside a Modal's own window (its ModalAttachedWatcher); React
        Native's KeyboardAvoidingView does nothing on edge-to-edge Android, where the keyboard hid the composer. */}
    <KeyboardAvoidingView behavior="padding" style={styles.fill}>
    <View style={styles.body}>
      {error
        ? <Notice title="The canvas could not be loaded" detail={error} />
        : !record
          ? <Loading label="Loading canvas" />
          : showSource
            ? <>
              <View style={styles.sourceBar}>
                <Text style={[styles.sourcePath, { color: sourceDraft ? colors.orange : colors.muted }]} numberOfLines={1}>{sourceEditable ? (sourceDraft ? 'Unsaved changes' : 'Saved') : record.path}</Text>
                {sourceEditable && sourceDraft ? <Pressable testID="canvas-source-discard" accessibilityRole="button" disabled={saving} onPress={discardSource} style={styles.actionButton}><Text style={[styles.action, { color: colors.muted }]}>Discard</Text></Pressable> : null}
                {sourceEditable && sourceDraft ? <Pressable testID="canvas-source-save" accessibilityRole="button" disabled={saving} onPress={() => void saveSource()} style={styles.actionButton}><Text style={[styles.action, { color: colors.blue }]}>{saving ? 'Saving…' : 'Save'}</Text></Pressable> : null}
                <Pressable accessibilityRole="button" onPress={() => setShowSource(false)} style={styles.actionButton}><Text style={[styles.action, { color: colors.blue }]}>Show preview</Text></Pressable>
              </View>
              {sourceDraft && sourceDraft.baseRevision !== record.revision ? <Text style={[styles.sourceNote, { color: colors.red }]}>The canvas changed after you started editing.</Text> : null}
              {saveError ? <Notice title="The canvas was not saved" detail={saveError} /> : null}
              {sourceEditable
                ? <MobileCodeEditor
                  ref={editorRef}
                  testID="canvas-source-editor"
                  path={record.path}
                  value={sourceDraft ? editorDocument.current : (editorDocument.current = record.source)}
                  readOnly={saving}
                  autoFocus={false}
                  onChange={value => setSourceDraft(current => value === record.source ? null : { text: value, baseRevision: current?.baseRevision ?? record.revision })}
                  onError={cause => setSaveError(errorText(cause))}
                  style={styles.fill}
                />
                : <ScrollView style={styles.fill} contentContainerStyle={styles.sourceContent}>
                  <ScrollView horizontal contentContainerStyle={styles.sourceRow}>
                    <Text selectable testID="canvas-source" style={[styles.code, { color: colors.text }]}>{record.source}</Text>
                  </ScrollView>
                </ScrollView>}
            </>
            : !compiled
              ? <ScrollView style={styles.fill}>
                <Notice title="This canvas did not compile" detail={record.diagnostics ?? 'The server returned no compiled output for this canvas.'} actions={record.diagnostics ? [showSourceAction, { label: 'Fix with agent', onPress: fixWithAgent }] : [showSourceAction]} />
              </ScrollView>
              : <>
                {pageError ? <Notice title="The canvas reported an error" detail={pageError} actions={[showSourceAction]} /> : null}

                {source
                  ? <WebView
                    ref={webViewRef}
                    testID="canvas-webview"
                    source={source}
                    originWhitelist={[CANVAS_PAGE_BASE_URL]}
                    javaScriptEnabled
                    domStorageEnabled={false}
                    cacheEnabled={false}
                    incognito
                    mixedContentMode="never"
                    allowFileAccess={false}
                    allowUniversalAccessFromFileURLs={false}
                    setSupportMultipleWindows={false}
                    style={[styles.fill, { backgroundColor: colors.surface }]}
                    onMessage={receive}
                    // A reload drops the injected highlights; re-run the open query once the fresh page has mounted.
                    onLoadEnd={() => { if (findOpen && findQuery) injectFind(findQuery); injectPins() }}
                    // The report is self-contained; anything else is a link the runtime should have reported through the bridge.
                    onShouldStartLoadWithRequest={navigation => navigation.url === CANVAS_PAGE_BASE_URL}
                    onError={event => setPageError(event.nativeEvent.description || 'The canvas page failed to load.')}
                  />
                  : <Loading label="Loading canvas runtime" />}
                {/* An overlay: pushing the page down while picking would move what the next tap lands on. */}
                {selecting ? <Text pointerEvents="none" style={[styles.selectingHint, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]}>Tap an element in the canvas to comment on it</Text> : null}
              </>}
    </View>
      {commentsAvailable && commentsOpen ? <CanvasCommentThreads
        threads={threads}
        activeId={activeThread}
        located={located}
        onActivate={activateThread}
        onReply={replyToThread}
        onStatus={setThreadStatus}
        onDelete={deleteThread}
      /> : null}
      {commentError ? <Text accessibilityRole="alert" style={[styles.commentError, { color: colors.red }]}>{commentError}</Text> : null}
      {selection && !showSource ? <View testID="canvas-comment-composer" style={[styles.composer, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <Text testID="canvas-comment-anchor" style={[styles.anchorLabel, { color: colors.muted }]} numberOfLines={1}>{canvasAnchorLabel({ canvas_id: selection.id, tag: selection.tag, text: selection.text })}</Text>
        <TextInput
          testID="canvas-comment-input"
          value={commentText}
          onChangeText={setCommentText}
          placeholder="Ask about this element, or describe a change…"
          placeholderTextColor={colors.muted}
          multiline
          autoFocus
          style={[styles.commentInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
        />
        <View style={styles.composerActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel comment" onPress={clearComposer} style={styles.actionButton}><Text style={[styles.action, { color: colors.muted }]}>Cancel</Text></Pressable>
          <CanvasCommentSubmit disabled={!commentText.trim() || commentBusy} onSubmit={mode => void submitComment(mode)} />
        </View>
      </View> : null}
    </KeyboardAvoidingView>
  </>
}

function Notice({ title, detail, actions = [] }: { title: string; detail: string; actions?: { label: string; onPress: () => void }[] }) {
  const colors = usePalette()
  return <View accessibilityRole="alert" style={[styles.notice, { borderColor: colors.red, backgroundColor: colors.dangerSurface }]}>
    <Text style={[styles.noticeTitle, { color: colors.red }]}>{title}</Text>
    <Text selectable style={[styles.code, { color: colors.text }]}>{detail}</Text>
    {actions.length ? <View style={styles.noticeActions}>
      {actions.map(action => <Pressable key={action.label} accessibilityRole="button" onPress={action.onPress} style={styles.actionButton}><Text style={[styles.action, { color: colors.blue }]}>{action.label}</Text></Pressable>)}
    </View> : null}
  </View>
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  grabber: { alignSelf: 'center', width: 36, height: 5, marginTop: 7, borderRadius: 3, backgroundColor: '#8a8a8a88' },
  top: { minHeight: 56, paddingLeft: 14, paddingRight: 6, paddingTop: 4, flexDirection: 'row', alignItems: 'center', gap: 4 },
  title: { flex: 1, fontSize: 16, fontWeight: '800' },
  switcher: { flexGrow: 0 },
  switcherContent: { paddingHorizontal: 14, paddingBottom: 8, gap: 8 },
  chip: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 12, minHeight: 30, justifyContent: 'center' },
  chipText: { fontSize: 12, fontWeight: '700', maxWidth: 200 },
  body: { flex: 1, minHeight: 0 },
  notice: { marginHorizontal: 14, marginBottom: 8, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 6 },
  noticeTitle: { fontSize: 13, fontWeight: '800' },
  code: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17 },
  actionButton: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  action: { fontSize: 12, fontWeight: '800' },
  findBar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingBottom: 8, minHeight: 44 },
  findInput: { flex: 1, height: 36, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, fontSize: 14 },
  findCount: { minWidth: 42, textAlign: 'center', fontSize: 12, fontVariant: ['tabular-nums'] },
  sourceBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 36 },
  sourcePath: { flex: 1, fontSize: 11, fontFamily: fonts.mono },
  sourceContent: { padding: 14, paddingTop: 4 },
  sourceRow: { minWidth: '100%' },
  sourceNote: { paddingHorizontal: 14, paddingBottom: 6, fontSize: 12 },
  noticeActions: { flexDirection: 'row', gap: 16 },
  selectingHint: { position: 'absolute', top: 8, alignSelf: 'center', borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 5, fontSize: 12, overflow: 'hidden' },
  anchorLabel: { fontSize: 11, fontFamily: fonts.mono },
  commentsToggle: { minHeight: 44, minWidth: 44, borderRadius: 8, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  commentCount: { minWidth: 18, paddingHorizontal: 5, borderRadius: 9, overflow: 'hidden', fontSize: 11, fontWeight: '800', textAlign: 'center', lineHeight: 18 },
  commentError: { paddingHorizontal: 14, paddingVertical: 6, fontSize: 12 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, gap: 8 },
  commentInput: { minHeight: 44, maxHeight: 140, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 14 },
  composerActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
})
