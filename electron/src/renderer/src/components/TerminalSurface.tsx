// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { CaseSensitive, ChevronDown, ChevronUp, ClipboardPaste, Copy, Eraser, Regex, Search, TextSelect, WholeWord, X } from 'lucide-react'
import { Terminal, type IMarker, type ITheme } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { Surface, TerminalConnectionState } from '@shared/types'
import { COLOR_THEMES } from '../lib/color-themes.data'
import { surfaceTitle } from '../lib/surfaces'
import { shellQuotePath, terminalKeyAction, type TerminalCommand } from '../lib/terminal-input'
import { DEFAULT_TERMINAL_FONT_FAMILY, clampTerminalFontSize, readTerminalSettings, useTerminalSettings } from '../lib/terminal-settings'
import { clearTerminalStatus, updateTerminalStatus } from '../lib/terminal-status'
import { currentShortcutPlatform } from './ShortcutTooltip'
import { useAppStore } from '../store/app-store'

/**
 * One shell on the active server. The tab opens its terminal and shell the first time it is shown,
 * then keeps both while hidden; the shell lives as long as its connection.
 */
export function TerminalSurface({ surface, active }: { surface: Surface; active: boolean }) {
  useLocale()
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const settings = useTerminalSettings()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const bellRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const commandRef = useRef<(command: TerminalCommand) => void>(() => undefined)
  // The server replays the shell's scrollback on every attach: its bells, notifications and
  // clipboard writes already happened once.
  const replayingRef = useRef(false)
  const activeRef = useRef(active)
  const surfaceRef = useRef(surface)
  const [opened, setOpened] = useState(active)
  const [ready, setReady] = useState(false)
  // Bumped by "New shell": the terminal and its scrollback stay, only the connection restarts.
  const [shellRun, setShellRun] = useState(0)
  const [connection, setConnection] = useState<TerminalConnectionState>('connecting')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  // ⌘+ / ⌘− size this tab only, as in Terminal.app; ⌘0 returns to the setting.
  const [fontZoom, setFontZoom] = useState(0)
  const [findOpen, setFindOpen] = useState(false)
  const [menuHasSelection, setMenuHasSelection] = useState(false)

  useEffect(() => {
    activeRef.current = active
    surfaceRef.current = surface
  })
  useEffect(() => { if (active) setOpened(true) }, [active])

  useEffect(() => {
    const host = hostRef.current
    if (!opened || !host) return
    const mac = currentShortcutPlatform() === 'mac'
    const initial = readTerminalSettings()
    const terminal = new Terminal({
      allowProposedApi: true,
      fontFamily: initial.fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
      fontSize: initial.fontSize,
      cursorStyle: initial.cursorStyle,
      cursorBlink: initial.cursorBlink,
      macOptionIsMeta: initial.optionAsMeta,
      macOptionClickForcesSelection: true,
      scrollback: initial.scrollback,
      screenReaderMode: initial.screenReader,
      theme: terminalTheme(),
      linkHandler: { activate: (event, uri) => openLink(event, uri, mac), allowNonHttpProtocols: false }
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    terminal.loadAddon(new Unicode11Addon())
    terminal.unicode.activeVersion = '11'
    terminal.loadAddon(new WebLinksAddon((event, uri) => openLink(event, uri, mac)))
    terminal.loadAddon(new ImageAddon())
    // OSC 52: programs may write the clipboard, never read it (the answer is empty).
    terminal.loadAddon(new ClipboardAddon(undefined, {
      readText: () => '',
      writeText: (_selection, text) => { if (!replayingRef.current) void window.agentsDock.native.writeClipboard(text) }
    }))
    terminal.open(host)
    try {
      const webgl = new WebglAddon()
      // A lost GPU context (too many tabs, GPU reset) falls back to the DOM renderer.
      webgl.onContextLoss(() => webgl.dispose())
      terminal.loadAddon(webgl)
    } catch {
      // No WebGL2: xterm.js keeps its DOM renderer.
    }

    let shellTitle: string | null = null
    terminal.onTitleChange(title => {
      shellTitle = title.trim() || null
      updateTerminalStatus(surface.id, { title: shellTitle })
    })
    terminal.parser.registerOscHandler(7, data => {
      try {
        const url = new URL(data)
        if (url.protocol === 'file:') updateTerminalStatus(surface.id, { cwd: decodeURIComponent(url.pathname) })
      } catch {
        // Not a file URL: nothing to track.
      }
      return true
    })
    let lastBell = 0
    terminal.onBell(() => {
      const now = Date.now()
      if (replayingRef.current || now - lastBell < 200) return
      lastBell = now
      bellRef.current?.animate?.([{ opacity: 0.16 }, { opacity: 0 }], { duration: 240, easing: 'ease-out' })
      if (!activeRef.current || !document.hasFocus()) updateTerminalStatus(surface.id, { bell: true })
    })
    const notify = (title: string, body: string) => {
      if (replayingRef.current || (activeRef.current && document.hasFocus())) return
      const state = useAppStore.getState()
      if (!state.activeProfileId) return
      void window.agentsDock.native.notify({
        title: title || surfaceTitle(surfaceRef.current, shellTitle),
        body,
        profileId: state.activeProfileId,
        serverIdentity: state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null,
        sessionId: surface.id,
        surface: true
      })
    }
    // iTerm2's OSC 9 message; ConEmu reuses OSC 9 with a numeric first field (progress), which is not one.
    terminal.parser.registerOscHandler(9, data => {
      if (/^\d+(;|$)/.test(data)) return false
      notify('', data)
      return true
    })
    // urxvt/foot/Ghostty: OSC 777;notify;<title>;<body>
    terminal.parser.registerOscHandler(777, data => {
      const [kind, title = '', ...body] = data.split(';')
      if (kind !== 'notify') return false
      notify(title, body.join(';'))
      return true
    })

    // OSC 133;A starts a prompt (fish 4 emits it); ⌘↑/⌘↓ move between them.
    let prompts: IMarker[] = []
    let jumpedTo: number | null = null
    terminal.parser.registerOscHandler(133, data => {
      if (data.startsWith('A')) {
        const marker = terminal.registerMarker(0)
        if (marker) prompts = [...prompts.filter(item => !item.isDisposed), marker]
      }
      return false
    })
    const jumpToPrompt = (direction: 1 | -1) => {
      const buffer = terminal.buffer.active
      // A jump past the last full screen leaves the view at the bottom; continue from that prompt.
      if (jumpedTo !== null && buffer.viewportY !== Math.min(jumpedTo, buffer.baseY)) jumpedTo = null
      const from = jumpedTo ?? (buffer.viewportY === buffer.baseY ? buffer.baseY + buffer.cursorY : buffer.viewportY)
      const lines = prompts.filter(marker => !marker.isDisposed).map(marker => marker.line)
      const target = direction < 0 ? lines.findLast(line => line < from) : lines.find(line => line > from)
      if (target === undefined) {
        jumpedTo = null
        if (direction > 0) terminal.scrollToBottom()
        return
      }
      jumpedTo = target
      terminal.scrollToLine(target)
    }

    commandRef.current = command => {
      if (command === 'copy') { if (terminal.hasSelection()) void window.agentsDock.native.writeClipboard(terminal.getSelection()) }
      else if (command === 'paste') void window.agentsDock.native.readClipboard().then(text => { if (text) terminal.paste(text) })
      else if (command === 'select-all') terminal.selectAll()
      else if (command === 'clear') terminal.clear()
      else if (command === 'zoom-in' || command === 'zoom-out') {
        const step = command === 'zoom-in' ? 1 : -1
        setFontZoom(zoom => clampTerminalFontSize(readTerminalSettings().fontSize + zoom + step) - readTerminalSettings().fontSize)
      }
      else if (command === 'zoom-reset') setFontZoom(0)
      else jumpToPrompt(command === 'previous-prompt' ? -1 : 1)
    }
    // xterm.js runs the key itself only when this returns true. Handled keys are prevented here,
    // which also keeps them from the menu accelerators; unhandled ⌘ chords still reach the menu.
    terminal.attachCustomKeyEventHandler(event => {
      const action = terminalKeyAction(event, mac)
      if (!action) return true
      if (event.type === 'keydown') {
        event.preventDefault()
        if ('send' in action) terminal.input(action.send, true)
        else commandRef.current(action.command)
      }
      return false
    })
    // Fires when a drag, double/triple click or shift-click ends, not on every mouse move.
    terminal.onSelectionChange(() => {
      if (readTerminalSettings().copyOnSelect && terminal.hasSelection()) void window.agentsDock.native.writeClipboard(terminal.getSelection())
    })
    const themeObserver = new MutationObserver(() => applyTheme(terminal, containerRef.current))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-color-theme'] })
    applyTheme(terminal, containerRef.current)
    terminalRef.current = terminal
    fitRef.current = fit
    searchRef.current = search
    setReady(true)
    return () => {
      themeObserver.disconnect()
      terminalRef.current = null
      fitRef.current = null
      searchRef.current = null
      commandRef.current = () => undefined
      setReady(false)
      terminal.dispose()
      clearTerminalStatus(surface.id)
    }
  }, [opened, surface.id])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!ready || !terminal) return
    terminal.options.fontFamily = settings.fontFamily || DEFAULT_TERMINAL_FONT_FAMILY
    terminal.options.fontSize = clampTerminalFontSize(settings.fontSize + fontZoom)
    terminal.options.cursorStyle = settings.cursorStyle
    terminal.options.cursorBlink = settings.cursorBlink
    terminal.options.macOptionIsMeta = settings.optionAsMeta
    terminal.options.scrollback = settings.scrollback
    terminal.options.screenReaderMode = settings.screenReader
    if (hostRef.current && fitRef.current) fitIfLaidOut(hostRef.current, fitRef.current)
  }, [ready, settings, fontZoom])

  useEffect(() => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!ready || !terminal || !fit || !host || !profileId) return
    const mine = (payload: { profileId?: string; profileGeneration?: number; sessionId: string }) =>
      payload.profileId === profileId && payload.profileGeneration === profileGeneration && payload.sessionId === surface.id
    const fitNow = () => fitIfLaidOut(host, fit)
    const removeData = window.agentsDock.events.on('terminal:data', payload => {
      if (!mine(payload)) return
      // The replay arrives as the first data after an attach.
      if (replayingRef.current) terminal.write(payload.data, () => { replayingRef.current = false })
      else terminal.write(payload.data)
    })
    const removeState = window.agentsDock.events.on('terminal:state', payload => {
      if (!mine(payload)) return
      setConnection(payload.state)
      setConnectionError(payload.error ?? null)
      if (payload.state === 'connected') {
        // The replay rebuilds the screen. RIS goes through the write queue, so output still
        // queued from the previous attach cannot land after it.
        replayingRef.current = true
        terminal.write('\x1bc')
        fitNow()
        // The server sized the pty from the connect request. A fit made while the link was still
        // opening (a hidden tab shown on a slow remote) never reached it, and fit() will not repeat it.
        window.agentsDock.terminal.resize(profileId, profileGeneration, surface.id, terminal.cols, terminal.rows)
        if (activeRef.current) terminal.focus()
      }
    })
    const input = terminal.onData(data => window.agentsDock.terminal.write(profileId, profileGeneration, surface.id, data))
    // X10 mouse reports for cells past column/row 95; the transport carries text, so only ASCII survives.
    const binary = terminal.onBinary(data => window.agentsDock.terminal.write(profileId, profileGeneration, surface.id, data))
    const resized = terminal.onResize(({ cols, rows }) => window.agentsDock.terminal.resize(profileId, profileGeneration, surface.id, cols, rows))
    const observer = new ResizeObserver(fitNow)
    observer.observe(host)
    setConnection('connecting')
    setConnectionError(null)
    fitNow()
    void window.agentsDock.terminal.connect(profileId, profileGeneration, surface.id, {
      cwd: surface.cwd,
      columns: terminal.cols,
      rows: terminal.rows
    }).catch(error => {
      setConnection('error')
      setConnectionError(errorText(error))
    })
    return () => {
      observer.disconnect()
      input.dispose()
      binary.dispose()
      resized.dispose()
      removeData()
      removeState()
      replayingRef.current = false
      void window.agentsDock.terminal.disconnect(profileId, profileGeneration, surface.id).catch(() => undefined)
    }
  }, [ready, profileId, profileGeneration, surface.id, surface.cwd, shellRun])

  useEffect(() => {
    if (!active || !ready) return
    updateTerminalStatus(surface.id, { bell: false })
    const frame = window.requestAnimationFrame(() => {
      if (hostRef.current && fitRef.current) fitIfLaidOut(hostRef.current, fitRef.current)
      terminalRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active, ready, surface.id])

  useEffect(() => {
    if (!active) return
    // ⌘F arrives as the Find menu command; with a terminal in front it searches the terminal.
    const find = (event: Event) => {
      event.preventDefault()
      setFindOpen(true)
    }
    window.addEventListener('agentsdock:find-active-surface', find)
    return () => window.removeEventListener('agentsdock:find-active-surface', find)
  }, [active])

  const closeFind = () => {
    setFindOpen(false)
    terminalRef.current?.focus()
  }
  const runCommand = (command: TerminalCommand) => {
    commandRef.current(command)
    terminalRef.current?.focus()
  }
  const dropFiles = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    const paths = [...event.dataTransfer.files].map(file => window.agentsDock.files.pathForFile(file)).filter(Boolean)
    const terminal = terminalRef.current
    if (!paths.length || !terminal) return
    // Uploads belong to a chat, so a terminal can only name files that are already on the server's disk.
    const state = useAppStore.getState()
    if (!serverOnThisComputer(state.profiles.find(profile => profile.id === state.activeProfileId)?.serverUrl)) {
      state.setError(t('surface.terminal.dropRemote'))
      return
    }
    terminal.input(`${paths.map(shellQuotePath).join(' ')} `, true)
    terminal.focus()
  }

  const starting = connection === 'connecting' || connection === 'reconnecting'
  return <div ref={containerRef} className="terminal-surface">
    <ContextMenu.Root onOpenChange={open => { if (open) setMenuHasSelection(Boolean(terminalRef.current?.hasSelection())) }}>
      <ContextMenu.Trigger asChild>
        <div
          ref={hostRef}
          className="terminal-surface-host"
          onContextMenu={event => {
            // A program that tracks the mouse gets the right click (tmux opens its own menu);
            // the modifier that forces a selection there forces this menu too.
            const forced = currentShortcutPlatform() === 'mac' ? event.altKey : event.shiftKey
            if (terminalRef.current?.modes.mouseTrackingMode !== 'none' && !forced) event.preventDefault()
          }}
          onDragOver={event => {
            if (!event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
          }}
          onDrop={dropFiles}
        />
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="menu-content" onCloseAutoFocus={event => { event.preventDefault(); terminalRef.current?.focus() }}>
          <ContextMenu.Item className="menu-item" disabled={!menuHasSelection} onSelect={() => runCommand('copy')}><Copy size={14} />{t('surface.terminal.copy')}</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => runCommand('paste')}><ClipboardPaste size={14} />{t('surface.terminal.paste')}</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => runCommand('select-all')}><TextSelect size={14} />{t('surface.terminal.selectAll')}</ContextMenu.Item>
          <ContextMenu.Separator className="menu-separator" />
          <ContextMenu.Item className="menu-item" onSelect={() => runCommand('clear')}><Eraser size={14} />{t('surface.terminal.clear')}</ContextMenu.Item>
          <ContextMenu.Item className="menu-item" onSelect={() => setFindOpen(true)}><Search size={14} />{t('surface.terminal.find')}</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    <div ref={bellRef} className="terminal-surface-bell" aria-hidden="true" />
    {findOpen && searchRef.current && <TerminalFindBar search={searchRef.current} onClose={closeFind} />}
    {connection !== 'connected' && <div className="terminal-surface-notice" role="status">
      <span>{starting ? t('surface.terminal.connecting') : connectionError ?? t('surface.terminal.exited')}</span>
      {!starting && <button type="button" className="quiet-button" onClick={() => setShellRun(run => run + 1)}>
        {connection === 'error' ? t('surface.terminal.retry') : t('surface.terminal.newShell')}
      </button>}
    </div>}
  </div>
}

function TerminalFindBar({ search, onClose }: { search: SearchAddon; onClose: () => void }) {
  useLocale()
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [results, setResults] = useState<{ index: number; count: number } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const find = (direction: 1 | -1, incremental = false) => {
    if (!query) return
    const options: ISearchOptions = { caseSensitive, regex, wholeWord, incremental, decorations: searchDecorations() }
    try {
      if (direction > 0) search.findNext(query, options)
      else search.findPrevious(query, options)
    } catch {
      // An unfinished regular expression matches nothing yet.
      search.clearDecorations()
      setResults({ index: -1, count: 0 })
    }
  }
  useEffect(() => {
    const subscription = search.onDidChangeResults(event => setResults({ index: event.resultIndex, count: event.resultCount }))
    inputRef.current?.focus()
    // Closing stops the addon re-searching after every write.
    return () => {
      subscription.dispose()
      search.clearDecorations()
    }
  }, [search])
  useEffect(() => {
    if (query) find(1, true)
    else {
      search.clearDecorations()
      setResults(null)
    }
  }, [query, caseSensitive, regex, wholeWord])

  const toggle = (label: string, pressed: boolean, set: (value: boolean) => void, Icon: typeof Regex) =>
    <button type="button" className={pressed ? 'active' : ''} aria-pressed={pressed} title={label} aria-label={label} onClick={() => { set(!pressed); inputRef.current?.focus() }}><Icon size={14} /></button>
  const count = results && results.count > 0
    ? t('surface.terminal.findCount', { index: results.index >= 0 ? results.index + 1 : '?', count: results.count >= 1000 ? '1000+' : results.count })
    : query ? t('surface.terminal.findNone') : ''
  return <div className="terminal-find" role="search">
    <input
      ref={inputRef}
      type="text"
      aria-label={t('surface.terminal.findPlaceholder')}
      placeholder={t('surface.terminal.findPlaceholder')}
      value={query}
      onChange={event => setQuery(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey ? -1 : 1) }
        else if (event.key === 'Escape') { event.preventDefault(); onClose() }
      }}
    />
    <span className="terminal-find-count" aria-live="polite">{count}</span>
    {toggle(t('surface.terminal.findCase'), caseSensitive, setCaseSensitive, CaseSensitive)}
    {toggle(t('surface.terminal.findWord'), wholeWord, setWholeWord, WholeWord)}
    {toggle(t('surface.terminal.findRegex'), regex, setRegex, Regex)}
    <button type="button" title={t('surface.terminal.findPrevious')} aria-label={t('surface.terminal.findPrevious')} disabled={!results?.count} onClick={() => find(-1)}><ChevronUp size={14} /></button>
    <button type="button" title={t('surface.terminal.findNext')} aria-label={t('surface.terminal.findNext')} disabled={!results?.count} onClick={() => find(1)}><ChevronDown size={14} /></button>
    <button type="button" title={t('surface.terminal.findClose')} aria-label={t('surface.terminal.findClose')} onClick={onClose}><X size={14} /></button>
  </div>
}

// ⌘-click (Ctrl-click elsewhere) opens a link, as in Terminal.app; a plain click selects or reaches the program.
function openLink(event: MouseEvent, uri: string, mac: boolean): void {
  if (!(mac ? event.metaKey : event.ctrlKey)) return
  void window.agentsDock.native.openExternal(uri).catch(() => undefined)
}

// The local hub, or another server on loopback that is not a hub remote (`/api/remote/<id>`).
function serverOnThisComputer(serverUrl: string | undefined): boolean {
  try {
    const url = new URL(serverUrl ?? '')
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.pathname.startsWith('/api/remote/')
  } catch {
    return false
  }
}

// A host still being laid out can measure a few pixels; FitAddon would clamp that to its minimum grid and push it to the shell.
function fitIfLaidOut(host: HTMLElement, fit: FitAddon): void {
  const bounds = host.getBoundingClientRect()
  if (bounds.width >= 32 && bounds.height >= 32) fit.fit()
}

// The padding around the grid shows the container, so it takes the terminal's background.
function applyTheme(terminal: Terminal, container: HTMLElement | null): void {
  const theme = terminalTheme()
  terminal.options.theme = theme
  if (container) container.style.background = theme.background ?? ''
}

// The search addon takes #RRGGBB only.
function searchDecorations(): ISearchOptions['decorations'] {
  const light = document.documentElement.dataset.theme === 'light'
  return light
    ? { matchBackground: '#fff2a8', matchOverviewRuler: '#d4a72c', activeMatchBackground: '#ffc83d', activeMatchColorOverviewRuler: '#bf8700' }
    : { matchBackground: '#5c4a12', matchOverviewRuler: '#d4a72c', activeMatchBackground: '#a87800', activeMatchColorOverviewRuler: '#ffc83d' }
}

function terminalTheme(): ITheme {
  const colorTheme = COLOR_THEMES.find(theme => theme.id === document.documentElement.dataset.colorTheme)
  if (colorTheme) return colorTheme.terminal
  if (document.documentElement.dataset.theme === 'light') {
    return {
      background: '#ffffff', foreground: '#1a1a1e', cursor: '#1675d1', cursorAccent: '#ffffff',
      selectionBackground: '#a9d2f4aa', black: '#252523', red: '#c43732', green: '#287f42', yellow: '#9a6b0b',
      blue: '#1769aa', magenta: '#8755a8', cyan: '#167a83', white: '#e9e9e6', brightBlack: '#74746f',
      brightRed: '#e0443e', brightGreen: '#369b54', brightYellow: '#b98210', brightBlue: '#2184d7',
      brightMagenta: '#a268c4', brightCyan: '#2098a2', brightWhite: '#ffffff'
    }
  }
  return {
    background: '#111212', foreground: '#e7e7e4', cursor: '#58a6ff', cursorAccent: '#111212',
    selectionBackground: '#2f628dcc', black: '#111212', red: '#ff625d', green: '#39d98a', yellow: '#f5b83d',
    blue: '#58a6ff', magenta: '#b7a0ff', cyan: '#4fcbd3', white: '#d8d8d5', brightBlack: '#73736f',
    brightRed: '#ff817d', brightGreen: '#62e6a6', brightYellow: '#ffd06b', brightBlue: '#82bdff',
    brightMagenta: '#d0c0ff', brightCyan: '#78e4e9', brightWhite: '#ffffff'
  }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
