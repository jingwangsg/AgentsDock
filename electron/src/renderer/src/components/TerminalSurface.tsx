// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { CaseSensitive, ChevronDown, ChevronUp, ClipboardPaste, Copy, Eraser, Regex, Search, TextSelect, WholeWord, X } from 'lucide-react'
import { Terminal, type IFunctionIdentifier, type IMarker, type ITerminalOptions, type ITheme } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { ImageAddon } from '@xterm/addon-image'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { Surface, TerminalConnectionState } from '@shared/types'
import { isLoopbackHostname } from '@shared/team-hub-url'
import { COLOR_THEMES } from '../lib/color-themes.data'
import { surfaceTitle } from '../lib/surfaces'
import { shellQuotePath, terminalKeyAction, type TerminalCommand } from '../lib/terminal-input'
import { trailingSequencesStart } from '../lib/terminal-replay'
import { DEFAULT_TERMINAL_FONT_FAMILY, clampTerminalFontSize, readTerminalSettings, useTerminalSettings, type TerminalSettings } from '../lib/terminal-settings'
import { clearTerminalStatus, updateTerminalStatus } from '../lib/terminal-status'
import { currentShortcutPlatform } from './ShortcutTooltip'
import { handleMenuCommand, useAppStore } from '../store/app-store'

// Queries a program sent before this attach. xterm.js answers them while it parses the replayed
// scrollback, and those answers would arrive at the shell as typed text.
const REPLAYED_CSI_QUERIES: IFunctionIdentifier[] = [
  { final: 'n' }, { prefix: '?', final: 'n' }, // DSR, CPR
  { final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' }, // DA1-3
  { prefix: '>', final: 'q' }, // XTVERSION
  { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }, // DECRQM
  { prefix: '?', final: 'u' }, // kitty keyboard flags
  { prefix: '?', final: 'S' } // XTSMGRAPHICS (image addon)
]
const REPLAYED_DCS_QUERIES: IFunctionIdentifier[] = [{ intermediates: '$', final: 'q' }, { intermediates: '+', final: 'q' }] // DECRQSS, XTGETTCAP
const WINDOW_REPORT_REQUESTS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]) // CSI Ps t
const REPLAYED_OSC_QUERIES = [4, 10, 11, 12, 17, 19, 52] // colors and OSC 52, each queried with '?'
const utf8 = new TextEncoder()

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
  // OSC 133 prompt marks. A reset (RIS) keeps markers on the lines it erased, so each attach drops them.
  const promptsRef = useRef<IMarker[]>([])
  // The server replays the shell's scrollback on every attach: its bells, notifications and
  // clipboard writes already happened once. True while this attach's replay is parsed.
  const replayingRef = useRef(false)
  // The replay's queries were answered when the program sent them, except the ones that end it,
  // which the program may still be waiting on. True while the part before those is parsed.
  const staleQueriesRef = useRef(false)
  // Counts attaches, so a replay that finishes after a newer attach began cannot end that one's.
  const attachRef = useRef(0)
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
  // 0 while the find bar is closed; each Find request bumps it so an open bar takes the focus again.
  const [findRequest, setFindRequest] = useState(0)
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
    const terminal = new Terminal({
      ...xtermOptions(readTerminalSettings(), 0),
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
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

    // Replayed queries. Registered after the addons: the parser asks the newest handler first, and
    // these return true (consumed) only for an already answered query, so live ones are answered.
    const stale = () => staleQueriesRef.current
    for (const id of REPLAYED_CSI_QUERIES) terminal.parser.registerCsiHandler(id, stale)
    terminal.parser.registerCsiHandler({ final: 't' }, params => stale() && WINDOW_REPORT_REQUESTS.has(Number(params[0])))
    for (const id of REPLAYED_DCS_QUERIES) terminal.parser.registerDcsHandler(id, stale)
    for (const ident of REPLAYED_OSC_QUERIES) terminal.parser.registerOscHandler(ident, data => stale() && data.split(';').includes('?'))

    // Shell status: OSC 0/2 title and OSC 7 working directory name the tab; a bell flashes it and
    // marks it while it is out of sight.
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

    // Notifications (OSC 9, OSC 777) while the tab is out of sight, at most one a second per tab.
    let lastNotice = 0
    const notify = (title: string, body: string) => {
      const now = Date.now()
      if (replayingRef.current || (activeRef.current && document.hasFocus()) || now - lastNotice < 1000) return
      const state = useAppStore.getState()
      if (!state.activeProfileId) return
      lastNotice = now
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

    // Prompt marks and terminal commands. OSC 133 only observes, so it returns false and leaves the
    // sequence to any other handler; the handlers above consume theirs.
    terminal.parser.registerOscHandler(133, data => {
      if (data.startsWith('A')) {
        const marker = terminal.registerMarker(0)
        if (marker) promptsRef.current = [...promptsRef.current.filter(item => !item.isDisposed), marker]
      }
      return false
    })
    commandRef.current = command => {
      switch (command) {
        case 'copy':
          if (terminal.hasSelection()) void window.agentsDock.native.writeClipboard(terminal.getSelection())
          break
        case 'paste':
          void window.agentsDock.native.readClipboard().then(text => { if (text) terminal.paste(text) })
          break
        case 'select-all': terminal.selectAll(); break
        case 'clear': terminal.clear(); break
        case 'find': setFindRequest(request => request + 1); break
        case 'close': handleMenuCommand('close-surface', useAppStore.getState, value => useAppStore.setState(value)); break
        case 'zoom-in':
        case 'zoom-out': {
          const base = readTerminalSettings().fontSize
          setFontZoom(zoom => clampTerminalFontSize(base + zoom + (command === 'zoom-in' ? 1 : -1)) - base)
          break
        }
        case 'zoom-reset': setFontZoom(0); break
        case 'previous-prompt':
        case 'next-prompt': {
          // A prompt is scrolled to the top line. Prompts below the top line are already on screen,
          // so ⌘↑ goes to the first one above it, and ⌘↓ past the last one returns to the bottom.
          const top = terminal.buffer.active.viewportY
          const lines = promptsRef.current.filter(marker => !marker.isDisposed).map(marker => marker.line)
          const target = command === 'previous-prompt' ? lines.findLast(line => line < top) : lines.find(line => line > top)
          if (target !== undefined) terminal.scrollToLine(target)
          else if (command === 'next-prompt') terminal.scrollToBottom()
          break
        }
      }
    }

    // Keys and selection. xterm.js runs a key itself only when the handler returns true. Handled
    // keys are prevented here, which also keeps them from the menu accelerators; unhandled ⌘ chords
    // still reach the menu. Copy on select copies what the mouse selected, not a Find match,
    // Select All or a right-click word.
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
    let mouseSelecting = false
    const startMouseSelection = (event: MouseEvent) => { if (event.button === 0) mouseSelecting = true }
    // xterm.js reports the selection from its own mouseup listener, which runs before this timer.
    const endMouseSelection = () => { if (mouseSelecting) window.setTimeout(() => { mouseSelecting = false }) }
    host.addEventListener('mousedown', startMouseSelection, true)
    window.addEventListener('mouseup', endMouseSelection)
    terminal.onSelectionChange(() => {
      if (mouseSelecting && readTerminalSettings().copyOnSelect && terminal.hasSelection()) void window.agentsDock.native.writeClipboard(terminal.getSelection())
    })

    // Theme: follows the app's light/dark and color theme.
    const themeObserver = new MutationObserver(() => applyTheme(terminal, containerRef.current))
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-color-theme'] })
    applyTheme(terminal, containerRef.current)

    terminalRef.current = terminal
    fitRef.current = fit
    searchRef.current = search
    setReady(true)
    return () => {
      host.removeEventListener('mousedown', startMouseSelection, true)
      window.removeEventListener('mouseup', endMouseSelection)
      themeObserver.disconnect()
      terminalRef.current = null
      fitRef.current = null
      searchRef.current = null
      commandRef.current = () => undefined
      promptsRef.current = []
      setReady(false)
      terminal.dispose()
      clearTerminalStatus(surface.id)
    }
  }, [opened, surface.id])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!ready || !terminal) return
    Object.assign(terminal.options, xtermOptions(settings, fontZoom))
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
    // Bytes of this attach's replay still to come. A server that reports `replayBytes` sends the
    // replay as the data right after `connected` (0: no replay); for an older one that does not,
    // its first data event is the replay (null).
    let replayLeft: number | null = 0
    const removeData = window.agentsDock.events.on('terminal:data', payload => {
      if (!mine(payload)) return
      if (replayLeft === 0) {
        terminal.write(payload.data)
        return
      }
      replayLeft = replayLeft === null ? 0 : Math.max(0, replayLeft - utf8.encode(payload.data).length)
      if (replayLeft > 0) {
        terminal.write(payload.data)
        return
      }
      const attach = attachRef.current
      const pending = trailingSequencesStart(payload.data)
      const tail = payload.data.slice(pending)
      terminal.write(payload.data.slice(0, pending), () => {
        if (attachRef.current !== attach) return
        staleQueriesRef.current = false
        if (!tail) replayingRef.current = false
      })
      if (tail) terminal.write(tail, () => { if (attachRef.current === attach) replayingRef.current = false })
    })
    const removeState = window.agentsDock.events.on('terminal:state', payload => {
      if (!mine(payload)) return
      setConnection(payload.state)
      setConnectionError(payload.error ?? null)
      if (payload.state === 'connected') {
        attachRef.current += 1
        replayLeft = payload.replayBytes ?? null
        replayingRef.current = staleQueriesRef.current = replayLeft !== 0
        // The replay rebuilds the screen. RIS goes through the write queue, so output still
        // queued from the previous attach cannot land after it.
        terminal.write('\x1bc', () => {
          for (const marker of promptsRef.current) marker.dispose()
          promptsRef.current = []
        })
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
      replayingRef.current = staleQueriesRef.current = false
      void window.agentsDock.terminal.disconnect(profileId, profileGeneration, surface.id).catch(() => undefined)
    }
  }, [ready, profileId, profileGeneration, surface.id, surface.cwd, shellRun])

  useEffect(() => {
    if (!active || !ready) return
    // The bell mark is for a tab out of sight; coming back to the window or the terminal clears it.
    const clearBell = () => updateTerminalStatus(surface.id, { bell: false })
    clearBell()
    const textarea = terminalRef.current?.textarea
    window.addEventListener('focus', clearBell)
    textarea?.addEventListener('focus', clearBell)
    const frame = window.requestAnimationFrame(() => {
      if (hostRef.current && fitRef.current) fitIfLaidOut(hostRef.current, fitRef.current)
      terminalRef.current?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('focus', clearBell)
      textarea?.removeEventListener('focus', clearBell)
    }
  }, [active, ready, surface.id])

  useEffect(() => {
    if (!active) return
    // ⌘F arrives as the Find menu command; with a terminal in front it searches the terminal.
    const find = (event: Event) => {
      event.preventDefault()
      setFindRequest(request => request + 1)
    }
    window.addEventListener('agentsdock:find-active-surface', find)
    return () => window.removeEventListener('agentsdock:find-active-surface', find)
  }, [active])

  const closeFind = () => {
    setFindRequest(0)
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
    // Uploads belong to a chat, so a terminal can only name files already on the server's disk:
    // the local hub, or another loopback server that is not a hub remote (`/api/remote/<id>`).
    const state = useAppStore.getState()
    let local = false
    try {
      const url = new URL(state.profiles.find(profile => profile.id === state.activeProfileId)?.serverUrl ?? '')
      local = isLoopbackHostname(url.hostname) && !url.pathname.startsWith('/api/remote/')
    } catch {
      // No usable server address: treat it as remote.
    }
    if (!local) {
      state.setError(t('surface.terminal.dropRemote'))
      return
    }
    const words = paths.map(shellQuotePath)
    if (words.includes(null)) {
      state.setError(t('surface.terminal.dropControlCharacter'))
      return
    }
    terminal.input(`${words.join(' ')} `, true)
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
          <ContextMenu.Item className="menu-item" onSelect={() => setFindRequest(request => request + 1)}><Search size={14} />{t('surface.terminal.find')}</ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    <div ref={bellRef} className="terminal-surface-bell" aria-hidden="true" />
    {findRequest > 0 && searchRef.current && <TerminalFindBar search={searchRef.current} focusRequest={findRequest} onClose={closeFind} />}
    {connection !== 'connected' && <div className="terminal-surface-notice" role="status">
      <span>{starting ? t('surface.terminal.connecting') : connectionError ?? t('surface.terminal.exited')}</span>
      {!starting && <button type="button" className="quiet-button" onClick={() => setShellRun(run => run + 1)}>
        {connection === 'error' ? t('surface.terminal.retry') : t('surface.terminal.newShell')}
      </button>}
    </div>}
  </div>
}

function TerminalFindBar({ search, focusRequest, onClose }: { search: SearchAddon; focusRequest: number; onClose: () => void }) {
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
    // Closing stops the addon re-searching after every write.
    return () => {
      subscription.dispose()
      search.clearDecorations()
    }
  }, [search])
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRequest])
  useEffect(() => {
    // The addon records the new options before comparing them with the last search, so with an
    // unchanged query it would keep the old highlights and count; clearing forces a new search.
    search.clearDecorations()
    if (query) find(1, true)
    else setResults(null)
  }, [query, caseSensitive, regex, wholeWord])

  const toggle = (label: string, pressed: boolean, set: (value: boolean) => void, Icon: typeof Regex) =>
    <button type="button" className={pressed ? 'active' : ''} aria-pressed={pressed} title={label} aria-label={label} onClick={() => { set(!pressed); inputRef.current?.focus() }}><Icon size={14} /></button>
  // The addon stops counting at its highlight limit (1000 matches) and then reports the active
  // match's index as -1.
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

// The terminal options that follow Settings → Terminal and the tab's ⌘+/⌘− zoom.
function xtermOptions(settings: TerminalSettings, fontZoom: number): ITerminalOptions {
  return {
    fontFamily: settings.fontFamily || DEFAULT_TERMINAL_FONT_FAMILY,
    fontSize: clampTerminalFontSize(settings.fontSize + fontZoom),
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    macOptionIsMeta: settings.optionAsMeta,
    scrollback: settings.scrollback,
    screenReaderMode: settings.screenReader
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
