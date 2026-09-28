// Page sheet that shows one chat's Canvas reports: port of the Electron CanvasPane without element selection.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'
import { RefreshCw } from 'lucide-react-native'
import { buildCanvasPage, parseCanvasPageMessage, type CanvasHostTheme } from '../lib/canvas-page'
import { fonts } from '../lib/typography'
import { client, useAppStore } from '../store/useAppStore'
import { useAppColorScheme, usePalette } from '../theme'
import type { CanvasRecord, CanvasSummary, Event } from '../types'
import { Text } from './AppText'
import { IconButton, Loading, SheetCloseButton } from './ui'

const STATE_SAVE_DELAY_MS = 400
// Opaque origin: the page has no server to talk to, and its CSP allows data: scripts only.
const CANVAS_PAGE_BASE_URL = 'about:blank'
const EMPTY_EVENTS: Event[] = []

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

  const receive = (event: WebViewMessageEvent) => {
    const message = parseCanvasPageMessage(event.nativeEvent.data)
    if (!message) return
    switch (message.kind) {
      case 'ready':
        setPageError(null)
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
      case 'link':
        if (/^https?:\/\//i.test(message.url)) void Linking.openURL(message.url).catch(() => undefined)
        break
    }
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

  const switchTo = (next: string) => {
    if (next === name) return
    setRecord(null)
    setPageError(null)
    setShowSource(false)
    setName(next)
  }
  const showSourceAction = { label: 'Show source', onPress: () => setShowSource(true) }

  return <>
    <View style={styles.top}>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>Canvas · {name}</Text>
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
    <View style={styles.body}>
      {error
        ? <Notice title="The canvas could not be loaded" detail={error} />
        : !record
          ? <Loading label="Loading canvas" />
          : showSource
            ? <>
              <View style={styles.sourceBar}>
                <Text style={[styles.sourcePath, { color: colors.muted }]} numberOfLines={1}>{record.path}</Text>
                <Pressable accessibilityRole="button" onPress={() => setShowSource(false)} style={styles.actionButton}><Text style={[styles.action, { color: colors.blue }]}>Show preview</Text></Pressable>
              </View>
              <ScrollView style={styles.fill} contentContainerStyle={styles.sourceContent}>
                <ScrollView horizontal contentContainerStyle={styles.sourceRow}>
                  <Text selectable testID="canvas-source" style={[styles.code, { color: colors.text }]}>{record.source}</Text>
                </ScrollView>
              </ScrollView>
            </>
            : !compiled
              ? <ScrollView style={styles.fill}>
                <Notice title="This canvas did not compile" detail={record.diagnostics ?? 'The server returned no compiled output for this canvas.'} action={showSourceAction} />
              </ScrollView>
              : <>
                {pageError ? <Notice title="The canvas reported an error" detail={pageError} action={showSourceAction} /> : null}
                {source
                  ? <WebView
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
                    // The report is self-contained; anything else is a link the runtime should have reported through the bridge.
                    onShouldStartLoadWithRequest={navigation => navigation.url === CANVAS_PAGE_BASE_URL}
                    onError={event => setPageError(event.nativeEvent.description || 'The canvas page failed to load.')}
                  />
                  : <Loading label="Loading canvas runtime" />}
              </>}
    </View>
  </>
}

function Notice({ title, detail, action }: { title: string; detail: string; action?: { label: string; onPress: () => void } }) {
  const colors = usePalette()
  return <View accessibilityRole="alert" style={[styles.notice, { borderColor: colors.red, backgroundColor: colors.dangerSurface }]}>
    <Text style={[styles.noticeTitle, { color: colors.red }]}>{title}</Text>
    <Text selectable style={[styles.code, { color: colors.text }]}>{detail}</Text>
    {action ? <Pressable accessibilityRole="button" onPress={action.onPress} style={styles.actionButton}><Text style={[styles.action, { color: colors.blue }]}>{action.label}</Text></Pressable> : null}
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
  sourceBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, minHeight: 36 },
  sourcePath: { flex: 1, fontSize: 11, fontFamily: fonts.mono },
  sourceContent: { padding: 14, paddingTop: 4 },
  sourceRow: { minWidth: '100%' },
})
