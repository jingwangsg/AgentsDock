import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { ChevronLeft, ChevronRight, ClipboardCopy, ClipboardPaste, Columns2, Keyboard as KeyboardIcon, Plus, Rows2, Trash2, X } from 'lucide-react-native'
import { AgentServerClientDisposedError, type AgentServerClient } from '../api/AgentServerClient'
import { scaleAppFont } from '../lib/typography'
import { capturedConnectionIsCurrent, client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { TerminalWindow } from '../types'
import { Text } from './AppText'
import { TerminalViewport, type TerminalViewportHandle } from './terminal/TerminalViewport'
import type { TerminalKeyName, TerminalModifierState } from './terminal/TerminalViewport.types'
import { IconButton } from './ui'

/** Keys a soft keyboard lacks; Ctrl and Alt stay pressed for the next key. Android only: the web view terminal sends them. */
const TERMINAL_KEYS: { name: TerminalKeyName | 'ctrl' | 'alt'; label: string }[] = [
  { name: 'escape', label: 'Esc' }, { name: 'tab', label: 'Tab' }, { name: 'enter', label: 'Enter' }, { name: 'ctrl', label: 'Ctrl' }, { name: 'alt', label: 'Alt' },
  { name: 'left', label: '←' }, { name: 'down', label: '↓' }, { name: 'up', label: '↑' }, { name: 'right', label: '→' },
  { name: 'home', label: 'Home' }, { name: 'end', label: 'End' }, { name: 'pageup', label: 'PgUp' }, { name: 'pagedown', label: 'PgDn' },
  { name: 'dash', label: '-' }, { name: 'slash', label: '/' }, { name: 'pipe', label: '|' }, { name: 'tilde', label: '~' },
]

/** What a terminal shows: a chat's tmux session or a terminal tab's shell on the server. */
type TerminalTarget = { id: string; cwd?: string | null }

interface ScopedTerminalViewProps {
  terminal: TerminalTarget
  tmux: boolean
  onClose?: () => void
  connection: AgentServerClient
  connectionKey: string
  activeProfileId: string | null
  profileGeneration: number
  fontScale: number
}

export function TerminalView({ terminal, tmux = false, onClose }: { terminal: TerminalTarget; tmux?: boolean; onClose?: () => void }) {
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
    onClose={onClose}
    connection={connection}
    connectionKey={connectionKey}
    activeProfileId={activeProfileId}
    profileGeneration={profileGeneration}
    fontScale={fontScale}
  />
}

function ScopedTerminalView({ terminal, tmux, onClose, connection, connectionKey, activeProfileId, profileGeneration, fontScale }: ScopedTerminalViewProps) {
  const colors = usePalette()
  const viewport = useRef<TerminalViewportHandle>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [windows, setWindows] = useState<TerminalWindow[]>([])
  const [status, setStatus] = useState('Connecting')
  const [notice, setNotice] = useState('')
  const [modifiers, setModifiers] = useState<TerminalModifierState>({ ctrl: false, alt: false })
  const rootRef = useRef<View>(null)
  const [keyboardOverlap, setKeyboardOverlap] = useState(0)
  useEffect(() => {
    if (Platform.OS !== 'android') return
    // The key row has to stay above the soft keyboard. The compact layout shows the terminal
    // in a full-screen Modal whose window does not shrink for the keyboard, so measure how far
    // the keyboard reaches into this view; a window that did shrink measures zero overlap.
    const shown = Keyboard.addListener('keyboardDidShow', event => {
      rootRef.current?.measureInWindow((_x, y, _width, height) => {
        setKeyboardOverlap(Math.max(0, Math.round(y + height - event.endCoordinates.screenY)))
      })
    })
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardOverlap(0))
    return () => { shown.remove(); hidden.remove() }
  }, [])
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
      const nativeTerminal = viewport.current
      if (nativeTerminal) void nativeTerminal.blur().catch(() => undefined)
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
  const pressKey = (name: TerminalKeyName | 'ctrl' | 'alt') => {
    const handle = viewport.current
    if (!handle?.sendKey || !handle.setModifier) return
    if (name === 'ctrl' || name === 'alt') {
      const next = !modifiers[name]
      setModifiers(current => ({ ...current, [name]: next }))
      void handle.setModifier(name, next)
      return
    }
    void handle.sendKey(name)
  }
  const close = () => {
    const nativeTerminal = viewport.current
    if (nativeTerminal) void nativeTerminal.blur().catch(() => undefined)
    onClose?.()
  }
  return <View ref={rootRef} collapsable={false} style={[styles.root, { backgroundColor: colors.background, borderColor: colors.border, paddingBottom: keyboardOverlap }]}>
    <View
      collapsable={false}
      pointerEvents="auto"
      testID="terminal-toolbar"
      style={[styles.tabs, { backgroundColor: colors.background, borderColor: colors.border }]}
    >
      <View style={styles.status}><View style={[styles.statusDot, { backgroundColor: status === 'Connected' ? colors.green : colors.orange }]} /><Text style={{ color: colors.muted, fontSize: 10 }} numberOfLines={1}>{notice || status}</Text></View>
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
      </ScrollView>
      <IconButton icon={KeyboardIcon} size={14} label="Focus terminal keyboard" onPress={() => void viewport.current?.focus()} />
      {onClose ? <IconButton icon={X} size={17} touchSize={44} label="Close terminal" testID="terminal-close" onPress={close} /> : null}
    </View>
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
        fontSize={scaleAppFont(13, fontScale)}
        style={styles.terminal}
        onStatus={event => {
          if (!capturedConnectionIsCurrent(connection, activeProfileId, profileGeneration)) return
          const value = event.nativeEvent
          setStatus(value.status)
          if (value.message) setNotice(value.message)
          if (value.status === 'Connected' && tmux) void refresh()
        }}
        onModifiers={setModifiers}
      />
    </View>
    {Platform.OS === 'android' ? <View collapsable={false} testID="terminal-key-row" style={[styles.keyRow, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.keyRowContent}>
        {TERMINAL_KEYS.map(key => {
          const active = key.name === 'ctrl' ? modifiers.ctrl : key.name === 'alt' ? modifiers.alt : false
          return <Pressable
            key={key.name}
            accessibilityRole="button"
            accessibilityLabel={`${key.label} key`}
            accessibilityState={{ selected: active }}
            testID={`terminal-key-${key.name}`}
            onPress={() => pressKey(key.name)}
            style={[styles.key, { borderColor: colors.border, backgroundColor: active ? colors.blue : colors.surface }]}
          >
            <Text style={[styles.keyLabel, { color: active ? colors.background : colors.text }]}>{key.label}</Text>
          </Pressable>
        })}
      </ScrollView>
    </View> : null}
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
  terminalViewport: { position: 'relative', zIndex: 0, flex: 1, minHeight: 0, overflow: 'hidden' },
  terminal: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  keyRow: { flexShrink: 0, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  keyRowContent: { alignItems: 'center', gap: 6, paddingHorizontal: 8 },
  key: { minWidth: 40, minHeight: 36, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  keyLabel: { fontSize: 13, fontWeight: '600' },
  unavailable: { flex: 1, minHeight: 0, alignItems: 'center', justifyContent: 'center', padding: 24 },
  unavailableTitle: { fontSize: 11, fontWeight: '700' },
  unavailableText: { maxWidth: 320, textAlign: 'center', fontSize: 12, lineHeight: 18 },
})
