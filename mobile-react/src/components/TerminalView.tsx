import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { AppState, Keyboard, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import * as Haptics from 'expo-haptics'
import { AArrowDown, AArrowUp, CaseSensitive, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ClipboardCopy, ClipboardPaste, Columns2, Keyboard as KeyboardIcon, Plus, Regex, Rows2, Search, TextCursor, Trash2, WholeWord, X, type LucideIcon } from 'lucide-react-native'
import { AgentServerClientDisposedError, type AgentServerClient } from '../api/AgentServerClient'
import { surfaceTitle } from '../lib/surfaces'
import { useTerminalSettings } from '../lib/terminalSettings'
import { updateTerminalStatus } from '../lib/terminalStatus'
import { scaleAppFont } from '../lib/typography'
import { capturedConnectionIsCurrent, client, notifyTerminalTab, useAppStore } from '../store/useAppStore'
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, clampTerminalFontSize, type TerminalFindOptions } from '../terminal/terminalPage'
import { useAppColorScheme, usePalette } from '../theme'
import type { TerminalWindow } from '../types'
import { Text, TextInput } from './AppText'
import { TerminalKeyLabel } from './terminal/TerminalKeyLabel'
import { TerminalViewport, type TerminalViewportHandle } from './terminal/TerminalViewport'
import type { TerminalKeyName, TerminalModifierState, TerminalPageEvent } from './terminal/TerminalViewport.types'
import { IconButton } from './ui'

type TerminalRowKey = TerminalKeyName | 'ctrl' | 'alt' | 'prompt-previous' | 'prompt-next'

/** Keys a soft keyboard lacks; Ctrl and Alt stay pressed for the next key. */
const TERMINAL_KEYS: { name: TerminalRowKey; label: string; description?: string }[] = [
  { name: 'escape', label: 'Esc' }, { name: 'tab', label: 'Tab' }, { name: 'backtab', label: '⇧Tab', description: 'Shift Tab' }, { name: 'enter', label: 'Enter' },
  { name: 'ctrl', label: 'Ctrl' }, { name: 'alt', label: 'Alt' },
  { name: 'left', label: '←' }, { name: 'down', label: '↓' }, { name: 'up', label: '↑' }, { name: 'right', label: '→' },
  { name: 'home', label: 'Home' }, { name: 'end', label: 'End' }, { name: 'pageup', label: 'PgUp' }, { name: 'pagedown', label: 'PgDn' },
  { name: 'dash', label: '-' }, { name: 'slash', label: '/' }, { name: 'pipe', label: '|' }, { name: 'tilde', label: '~' },
  // Prompts the shell marks with OSC 133, as ⌘↑/⌘↓ on the desktop.
  { name: 'prompt-previous', label: '⤒ Prompt', description: 'Previous prompt' }, { name: 'prompt-next', label: '⤓ Prompt', description: 'Next prompt' },
  ...Array.from({ length: 12 }, (_, index) => ({ name: `f${index + 1}` as TerminalKeyName, label: `F${index + 1}` })),
]
// A tab's own zoom (A−/A+, pinch, Ctrl+=/−/0) for this app run, kept when the tab's view is let go and made again.
const fontZooms = new Map<string, number>()
// Terminal tabs whose shell exited, until the user asks for a new shell: a view made again must not start one.
const exitedTerminals = new Set<string>()

/** What a terminal shows: a chat's tmux session or a terminal tab's shell on the server. */
type TerminalTarget = { id: string; cwd?: string | null }

interface ScopedTerminalViewProps {
  terminal: TerminalTarget
  tmux: boolean
  active: boolean
  onClose?: () => void
  connection: AgentServerClient
  connectionKey: string
  activeProfileId: string | null
  profileGeneration: number
  fontScale: number
}

export function TerminalView({ terminal, tmux = false, active = true, onClose }: { terminal: TerminalTarget; tmux?: boolean; active?: boolean; onClose?: () => void }) {
  const colors = usePalette()
  const activeProfileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const connecting = useAppStore(state => state.connecting)
  const switchingProfileId = useAppStore(state => state.switchingProfileId)
  const fontScale = useAppStore(state => state.fontScale)
  const connection = client
  const connectionKey = `${activeProfileId ?? 'none'}:${profileGeneration}`
  const connectionReady = connected && !connecting && !switchingProfileId && connection.isValidated
  if (!connectionReady) {
    return <View collapsable={false} style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <View style={[styles.tabs, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <Text style={[styles.unavailableTitle, { color: colors.muted }]} numberOfLines={1}>Terminal unavailable</Text>
        <View style={{ flex: 1 }} />
        {onClose ? <IconButton icon={X} size={17} touchSize={44} label="Close terminal" testID="terminal-close" onPress={onClose} /> : null}
      </View>
      <View style={styles.unavailable}>
        <Text style={[styles.unavailableText, { color: colors.muted }]}>{connecting || switchingProfileId ? 'Verifying server identity…' : 'Reconnect this server to open its terminal.'}</Text>
      </View>
    </View>
  }
  return <ScopedTerminalView
    key={`${connectionKey}:${terminal.id}`}
    terminal={terminal}
    tmux={tmux}
    active={active}
    onClose={onClose}
    connection={connection}
    connectionKey={connectionKey}
    activeProfileId={activeProfileId}
    profileGeneration={profileGeneration}
    fontScale={fontScale}
  />
}

function ScopedTerminalView({ terminal, tmux, active, onClose, connection, connectionKey, activeProfileId, profileGeneration, fontScale }: ScopedTerminalViewProps) {
  const colors = usePalette()
  const dark = useAppColorScheme() === 'dark'
  const settings = useTerminalSettings()
  const viewport = useRef<TerminalViewportHandle>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [windows, setWindows] = useState<TerminalWindow[]>([])
  const [status, setStatus] = useState('Connecting')
  const [statusMessage, setStatusMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [modifiers, setModifiers] = useState<TerminalModifierState>({ ctrl: false, alt: false })
  const [fontZoom, setFontZoom] = useState(() => fontZooms.get(terminal.id) ?? 0)
  // 0 while the find bar is closed; each Find request bumps it so an open bar takes the focus again.
  const [findRequest, setFindRequest] = useState(0)
  const [findResults, setFindResults] = useState<{ index: number; count: number } | null>(null)
  const [selecting, setSelecting] = useState(false)
  const shellTitle = useRef<string | null>(null)
  const lastNotice = useRef(0)
  // A terminal tab, not a chat's tmux session.
  const standalone = !tmux
  const baseFontSize = scaleAppFont(settings.fontSize, fontScale)
  const fontSize = clampTerminalFontSize(baseFontSize + fontZoom)
  const rootRef = useRef<View>(null)
  const [keyboardOverlap, setKeyboardOverlap] = useState(0)
  useEffect(() => {
    // The key row has to stay above the soft keyboard. The compact layout shows the terminal
    // in a full-screen Modal whose window does not shrink for the keyboard, and an iOS window
    // never does, so measure how far the keyboard reaches into this view; a window that did
    // shrink measures zero overlap. iOS: the "will" events, so the row moves with the keyboard.
    const ios = Platform.OS === 'ios'
    const shown = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', event => {
      rootRef.current?.measureInWindow((_x, y, _width, height) => {
        setKeyboardOverlap(Math.max(0, Math.round(y + height - event.endCoordinates.screenY)))
      })
    })
    const hidden = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardOverlap(0))
    return () => { shown.remove(); hidden.remove() }
  }, [])
  useEffect(() => { fontZooms.set(terminal.id, fontZoom) }, [fontZoom, terminal.id])
  useEffect(() => {
    if (!active) {
      void viewport.current?.blur().catch(() => undefined)
      return
    }
    // The bell mark is for a tab out of sight; showing the tab, or coming back to the app with it in front, clears it.
    if (standalone) updateTerminalStatus(terminal.id, { bell: false })
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && standalone) updateTerminalStatus(terminal.id, { bell: false })
    })
    return () => subscription.remove()
  }, [active, standalone, terminal.id])
  const refresh = useCallback(async () => {
    try {
      const next = await connection.terminalWindows(terminal.id)
      if (capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)) setWindows(next.windows)
    } catch (error) {
      if (capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration) && !(error instanceof AgentServerClientDisposedError)) {
        // The terminal websocket may still be creating its first window.
      }
    }
  }, [activeProfileId, connection, profileGeneration, terminal.id])
  useEffect(() => {
    setWindows([])
    setStatus('Connecting')
    setNotice('')
    if (tmux) void refresh()
    return () => {
      const terminalViewport = viewport.current
      if (terminalViewport) void terminalViewport.blur().catch(() => undefined)
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      noticeTimer.current = null
    }
  }, [connectionKey, refresh, tmux])
  const socketURL = useMemo(
    () => terminalSocketURL(connection, terminal),
    [connection, connectionKey, terminal.cwd, terminal.id],
  )
  const action = async (name: 'new-window' | 'split-right' | 'split-down' | 'next-window' | 'previous-window' | 'kill-window' | 'select-window', target?: string) => {
    try {
      const next = await connection.terminalAction(terminal.id, name, target)
      if (capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)) setWindows(next.windows)
    } catch (error) {
      if (capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration) && !(error instanceof AgentServerClientDisposedError)) {
        flash(error instanceof Error ? error.message : 'Terminal action failed')
      }
    }
  }
  const flash = (message: string) => {
    if (!capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)) return
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice(message)
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null
      if (capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)) setNotice('')
    }, 1_200)
  }
  const copy = async () => {
    const copied = await viewport.current?.copy()
    if (capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)) flash(copied ? 'Copied' : 'Select text to copy')
  }
  const paste = async () => {
    const pasted = await viewport.current?.paste()
    if (capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)) flash(pasted ? 'Pasted' : 'Clipboard empty')
  }
  const zoom = (step: -1 | 0 | 1) => setFontZoom(current => step === 0 ? 0 : clampTerminalFontSize(baseFontSize + current + step) - baseFontSize)
  const toggleSelecting = () => {
    const next = !selecting
    setSelecting(next)
    if (next) Keyboard.dismiss()
    void viewport.current?.selectText?.(next)
  }
  const pressKey = (name: TerminalRowKey) => {
    const handle = viewport.current
    if (!handle?.sendKey || !handle.setModifier) return
    if (name === 'ctrl' || name === 'alt') {
      const next = !modifiers[name]
      setModifiers(current => ({ ...current, [name]: next }))
      void handle.setModifier(name, next)
      return
    }
    if (name === 'prompt-previous' || name === 'prompt-next') {
      void handle.jumpPrompt?.(name === 'prompt-previous' ? 'previous' : 'next')
      return
    }
    void handle.sendKey(name)
  }
  const close = () => {
    const terminalViewport = viewport.current
    if (terminalViewport) void terminalViewport.blur().catch(() => undefined)
    onClose?.()
  }
  const pageEvent = (event: TerminalPageEvent) => {
    if (!capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)) return
    switch (event.type) {
      case 'title':
        shellTitle.current = event.title
        if (standalone) updateTerminalStatus(terminal.id, { title: event.title })
        return
      case 'cwd':
        if (standalone) updateTerminalStatus(terminal.id, { cwd: event.cwd })
        return
      case 'bell':
        if (active && AppState.currentState === 'active') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
        else if (standalone) updateTerminalStatus(terminal.id, { bell: true })
        return
      case 'notify': {
        // While the tab is hidden or the app is not in front, at most one a second. A notification opens a
        // terminal tab; a chat's tmux terminal has no tab to open.
        const surface = useAppStore.getState().surfaces.find(item => item.id === terminal.id)
        const now = Date.now()
        if (!standalone || !surface || (active && AppState.currentState === 'active') || now - lastNotice.current < 1000) return
        lastNotice.current = now
        notifyTerminalTab(terminal.id, event.title || surfaceTitle(surface, shellTitle.current), event.body)
        return
      }
      case 'find-results':
        setFindResults({ index: event.index, count: event.count })
        return
      case 'font-size':
        setFontZoom(event.fontSize - baseFontSize)
        return
      case 'command':
        if (event.command === 'find') setFindRequest(request => request + 1)
        else if (event.command === 'zoom-in') zoom(1)
        else if (event.command === 'zoom-out') zoom(-1)
        else if (event.command === 'zoom-reset') zoom(0)
        else if (event.command === 'close') {
          if (onClose) close()
          else if (standalone) void useAppStore.getState().removeSurface(terminal.id, profileGeneration)
        }
    }
  }
  const ended = status === 'Exited' || status === 'Error'
  return <View ref={rootRef} collapsable={false} style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: keyboardOverlap }]}>
    <View
      collapsable={false}
      pointerEvents="auto"
      testID="terminal-toolbar"
      style={[styles.tabs, { backgroundColor: colors.background, borderColor: colors.border }]}
    >
      <View style={styles.status}><View style={[styles.statusDot, { backgroundColor: status === 'Connected' ? colors.green : ended ? colors.red : colors.orange }]} /><Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={1}>{notice || status}</Text></View>
      <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} style={styles.tabScroller} contentContainerStyle={styles.tabContent}>
        {tmux ? <>{windows.map(window => <Pressable key={window.id} accessibilityRole="button" accessibilityLabel={`Terminal window ${window.name}`} accessibilityState={{ selected: window.active }} onPress={() => void action('select-window', String(window.index))} style={[styles.tab, { backgroundColor: window.active ? colors.raised : 'transparent' }]}><Text style={{ color: window.active ? colors.text : colors.muted, fontSize: 11 }} numberOfLines={1}>{window.name}</Text></Pressable>)}
        <IconButton icon={Plus} size={14} label="New window" onPress={() => void action('new-window')} />
        <IconButton icon={ChevronLeft} size={14} label="Previous window" onPress={() => void action('previous-window')} />
        <IconButton icon={ChevronRight} size={14} label="Next window" onPress={() => void action('next-window')} />
        <IconButton icon={Columns2} size={14} label="Split right" onPress={() => void action('split-right')} />
        <IconButton icon={Rows2} size={14} label="Split down" onPress={() => void action('split-down')} />
        <IconButton icon={Trash2} size={14} label="Close terminal window" onPress={() => void action('kill-window')} /></> : null}
        <IconButton icon={ClipboardCopy} size={14} label="Copy selection or terminal buffer" onPress={() => void copy()} />
        <IconButton icon={ClipboardPaste} size={14} label="Paste" onPress={() => void paste()} />
        <IconButton icon={TextCursor} size={14} label={selecting ? 'Done selecting text' : 'Select text'} testID="terminal-select-text" selected={selecting} onPress={toggleSelecting} />
        <IconButton icon={Search} size={14} label="Find" testID="terminal-find" onPress={() => setFindRequest(request => request + 1)} />
        <IconButton icon={AArrowDown} size={14} label="Smaller text" testID="terminal-zoom-out" disabled={fontSize <= TERMINAL_FONT_SIZE_MIN} onPress={() => zoom(-1)} />
        <IconButton icon={AArrowUp} size={14} label="Larger text" testID="terminal-zoom-in" disabled={fontSize >= TERMINAL_FONT_SIZE_MAX} onPress={() => zoom(1)} />
      </ScrollView>
      <IconButton icon={KeyboardIcon} size={14} label="Focus terminal keyboard" onPress={() => void viewport.current?.focus()} />
      {onClose ? <IconButton icon={X} size={17} touchSize={44} label="Close terminal" testID="terminal-close" onPress={close} /> : null}
    </View>
    {findRequest > 0 ? <TerminalFindBar
      viewport={viewport}
      focusRequest={findRequest}
      results={findResults}
      onResults={setFindResults}
      onClose={() => {
        setFindRequest(0)
        setFindResults(null)
        void viewport.current?.focus()
      }}
    /> : null}
    {selecting ? <View testID="terminal-select-hint" style={[styles.selectHint, { backgroundColor: colors.raised, borderColor: colors.border }]}>
      <Text style={[styles.selectHintText, { color: colors.muted }]} numberOfLines={2}>Long-press to select, drag the handles, then Copy.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Done selecting text" testID="terminal-select-done" onPress={toggleSelecting} style={styles.selectDone}><Text style={{ color: colors.blue, fontWeight: '700' }}>Done</Text></Pressable>
    </View> : null}
    <View collapsable={false} pointerEvents="box-none" testID="terminal-platform-viewport" style={styles.terminalViewport}>
      <TerminalViewport
        key={`${connectionKey}:${terminal.id}`}
        ref={viewport}
        socketURL={socketURL}
        backgroundHex={colors.surface}
        foregroundHex={colors.text}
        cursorHex={colors.blue}
        // Zed's text selection: the accent at 0x3d alpha.
        selectionHex={`${colors.blue}3d`}
        fontSize={fontSize}
        standalone={standalone}
        visible={active}
        exited={exitedTerminals.has(terminal.id)}
        dark={dark}
        cursorStyle={settings.cursorStyle}
        cursorBlink={settings.cursorBlink}
        scrollback={settings.scrollback}
        screenReader={settings.screenReader}
        copyOnSelect={settings.copyOnSelect}
        style={styles.terminal}
        onStatus={event => {
          if (!capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)) return
          const value = event.nativeEvent
          setStatus(value.status)
          setStatusMessage(value.message ?? '')
          // A reconnect's reason is stale once the terminal is back.
          if (value.message || value.status === 'Connected') setNotice(value.message ?? '')
          if (standalone && value.status === 'Exited') exitedTerminals.add(terminal.id)
          if (value.status === 'Connected' && tmux) void refresh()
        }}
        onModifiers={setModifiers}
        onPageEvent={pageEvent}
      />
      {ended ? <View testID="terminal-ended" style={[styles.ended, { backgroundColor: colors.raised, borderColor: colors.border }]}>
        <Text style={[styles.endedText, { color: colors.text }]} numberOfLines={3}>{status === 'Exited' ? 'The shell exited.' : statusMessage || 'Terminal connection failed.'}</Text>
        <Pressable
          accessibilityRole="button"
          testID="terminal-restart"
          onPress={() => {
            setNotice('')
            exitedTerminals.delete(terminal.id)
            void viewport.current?.restart?.()
          }}
          style={[styles.endedButton, { borderColor: colors.border }]}
        ><Text style={{ color: colors.blue, fontWeight: '700' }}>{status === 'Exited' ? 'New shell' : 'Retry'}</Text></Pressable>
      </View> : null}
    </View>
    <View collapsable={false} testID="terminal-key-row" style={[styles.keyRow, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.keyRowContent}>
        {TERMINAL_KEYS.map(key => {
          const active = key.name === 'ctrl' ? modifiers.ctrl : key.name === 'alt' ? modifiers.alt : false
          return <Pressable
            key={key.name}
            accessibilityRole="button"
            accessibilityLabel={`${key.description ?? key.label} key`}
            accessibilityState={{ selected: active }}
            testID={`terminal-key-${key.name}`}
            onPress={() => pressKey(key.name)}
            style={[styles.key, { borderColor: colors.border, backgroundColor: active ? colors.blue : colors.surface }]}
          >
            <TerminalKeyLabel label={key.label} style={[styles.keyLabel, { color: active ? colors.background : colors.text }]} />
          </Pressable>
        })}
      </ScrollView>
    </View>
  </View>
}

/** Port of the desktop's terminal find bar: case, whole word, regular expression and the match count. */
function TerminalFindBar({ viewport, focusRequest, results, onResults, onClose }: {
  viewport: RefObject<TerminalViewportHandle | null>
  focusRequest: number
  results: { index: number; count: number } | null
  onResults: (results: { index: number; count: number } | null) => void
  onClose: () => void
}) {
  const colors = usePalette()
  const input = useRef<TextInput>(null)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<TerminalFindOptions>({ caseSensitive: false, wholeWord: false, regex: false })
  const find = (direction: 1 | -1, incremental = false) => {
    if (query) void viewport.current?.find?.(query, options, direction, incremental)
  }
  // The first request is autoFocus: a focus() made while the field mounts does not raise the soft keyboard.
  const firstFocusRequest = useRef(focusRequest)
  useEffect(() => {
    if (focusRequest !== firstFocusRequest.current) input.current?.focus()
  }, [focusRequest])
  useEffect(() => {
    // The addon records the new options before comparing them with the last search, so with an
    // unchanged query it would keep the old highlights and count; clearing forces a new search.
    void viewport.current?.clearFind?.()
    if (query) find(1, true)
    else onResults(null)
  }, [query, options])
  // Closing stops the addon re-searching after every write.
  useEffect(() => () => { void viewport.current?.clearFind?.() }, [viewport])
  const toggle = (key: keyof TerminalFindOptions, label: string, icon: LucideIcon) =>
    <IconButton icon={icon} size={14} label={label} selected={options[key]} testID={`terminal-find-${key}`} onPress={() => setOptions(current => ({ ...current, [key]: !current[key] }))} />
  // The addon stops counting at its highlight limit (1000 matches) and then reports the active match's index as -1.
  const count = results && results.count > 0
    ? `${results.index >= 0 ? results.index + 1 : '?'} of ${results.count >= 1000 ? '1000+' : results.count}`
    : query ? 'No results' : ''
  return <View testID="terminal-find-bar" style={[styles.findBar, { backgroundColor: colors.background, borderColor: colors.border }]}>
    <TextInput
      ref={input}
      autoFocus
      testID="terminal-find-input"
      accessibilityLabel="Find in terminal"
      placeholder="Find"
      placeholderTextColor={colors.muted}
      value={query}
      onChangeText={setQuery}
      onSubmitEditing={() => find(1)}
      submitBehavior="submit"
      returnKeyType="search"
      autoCapitalize="none"
      autoCorrect={false}
      style={[styles.findInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.raised }]}
    />
    <Text testID="terminal-find-count" style={[styles.findCount, { color: colors.muted }]} numberOfLines={1}>{count}</Text>
    {toggle('caseSensitive', 'Match case', CaseSensitive)}
    {toggle('wholeWord', 'Whole word', WholeWord)}
    {toggle('regex', 'Regular expression', Regex)}
    <IconButton icon={ChevronUp} size={14} label="Previous match" testID="terminal-find-previous" disabled={!results?.count} onPress={() => find(-1)} />
    <IconButton icon={ChevronDown} size={14} label="Next match" testID="terminal-find-next" disabled={!results?.count} onPress={() => find(1)} />
    <IconButton icon={X} size={14} label="Close find" testID="terminal-find-close" onPress={onClose} />
  </View>
}

function terminalSocketURL(connection: AgentServerClient, terminal: TerminalTarget): string {
  const endpoint = new URL(connection.url(`/api/sessions/${encodeURIComponent(terminal.id)}/terminal/ws`))
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
  endpoint.searchParams.set('columns', '100')
  endpoint.searchParams.set('rows', '30')
  if (terminal.cwd) endpoint.searchParams.set('cwd', terminal.cwd)
  const token = connection.authHeaders()['X-ZenithDock-Token'] ?? ''
  if (token) endpoint.searchParams.set('token', token)
  return endpoint.toString()
}


const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, borderTopWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  tabs: { position: 'relative', zIndex: 2, flexShrink: 0, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 5, paddingVertical: 2, flexDirection: 'row', alignItems: 'center', gap: 4 },
  status: { maxWidth: 82, flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 3 },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  tabScroller: { flex: 1 },
  tabContent: { alignItems: 'center', gap: 4, paddingHorizontal: 2 },
  tab: { maxWidth: 120, minHeight: 44, borderRadius: 5, paddingHorizontal: 10, paddingVertical: 3, justifyContent: 'center' },
  findBar: { flexShrink: 0, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 2 },
  findInput: { flex: 1, minWidth: 80, height: 36, borderWidth: StyleSheet.hairlineWidth, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 0, fontSize: 13 },
  findCount: { minWidth: 56, fontSize: 11, textAlign: 'center', fontVariant: ['tabular-nums'] },
  selectHint: { flexShrink: 0, minHeight: 44, borderBottomWidth: StyleSheet.hairlineWidth, paddingLeft: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectHintText: { flex: 1, fontSize: 12 },
  selectDone: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center' },
  terminalViewport: { position: 'relative', zIndex: 0, flex: 1, minHeight: 0, overflow: 'hidden' },
  terminal: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  ended: { position: 'absolute', left: 14, right: 14, bottom: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingLeft: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  endedText: { flex: 1, fontSize: 13, paddingVertical: 10 },
  endedButton: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderLeftWidth: StyleSheet.hairlineWidth },
  keyRow: { flexShrink: 0, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  keyRowContent: { alignItems: 'center', gap: 6, paddingHorizontal: 8 },
  key: { minWidth: 40, minHeight: 36, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  keyLabel: { fontSize: 13, fontWeight: '600' },
  unavailable: { flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 24 },
  unavailableTitle: { fontSize: 11, fontWeight: '700' },
  unavailableText: { maxWidth: 320, textAlign: 'center', fontSize: 12, lineHeight: 18 },
})
