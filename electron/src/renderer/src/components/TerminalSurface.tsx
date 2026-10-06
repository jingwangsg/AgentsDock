// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useEffect, useRef, useState } from 'react'
import { FitAddon, Terminal, init, type ITheme } from 'ghostty-web'
import type { Surface, TerminalConnectionState } from '@shared/types'
import { COLOR_THEMES } from '../lib/color-themes.data'
import { terminalClipboardShortcut } from '../lib/terminal-shortcuts'
import { handleMenuCommand, useAppStore } from '../store/app-store'

// Chromium falls back per glyph across this list, so trailing Lilex (bundled; @font-face in
// zed-skin.css) covers powerline and box-drawing glyphs that SF Mono and Menlo miss.
const TERMINAL_FONT_FAMILY = '"SFMono-Regular", Menlo, Monaco, "Cascadia Mono", "Lilex", monospace'

// ghostty-web compiles its WASM once per renderer; every tab waits on the same promise.
let ghosttyReady: Promise<void> | null = null

// Primary Device Attributes request (CSI c / CSI 0 c) and Ghostty's own answer (VT220, ANSI color).
// ghostty-web 0.4.0's VT core answers DSR only (verified against its WASM, also in 0.4.0-next.20), and
// fish 4.1+ waits up to 10 s for this answer before its first prompt, which shows as an empty tab.
// Delete once ghostty-web answers DA1 itself.
const DA1_QUERY = /\x1b\[0?c/g
const DA1_RESPONSE = '\x1b[?62;22c'

/** One shell on the active server, rendered by Ghostty's terminal core. The shell lives as long as its connection. */
export function TerminalSurface({ surface, active }: { surface: Surface; active: boolean }) {
  useLocale()
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [ready, setReady] = useState(false)
  // Bumped by "New shell": the terminal and its scrollback stay, only the connection restarts.
  const [shellRun, setShellRun] = useState(0)
  const [connection, setConnection] = useState<TerminalConnectionState>('connecting')
  const [connectionError, setConnectionError] = useState<string | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let disposed = false
    let terminal: Terminal | null = null
    let themeObserver: MutationObserver | null = null
    void (ghosttyReady ??= init()).then(() => {
      if (disposed) return
      terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: 13,
        scrollback: 20_000,
        smoothScrollDuration: 0,
        theme: terminalTheme()
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(host)
      const current = terminal
      // ghostty-web's contract is the reverse of xterm.js: a truthy return means "handled here",
      // and the terminal then drops the key. Every key this handler does not claim must return
      // false, or nothing typed ever reaches the shell.
      terminal.attachCustomKeyEventHandler(event => {
        if (event.type !== 'keydown') return false
        const shortcut = terminalClipboardShortcut(event)
        if (shortcut === 'copy') {
          if (current.hasSelection()) void window.agentsDock.native.writeClipboard(current.getSelection())
          return true
        }
        if (shortcut === 'select-all') {
          current.selectAll()
          return true
        }
        // Electron's Edit menu turns ⌘V into a native paste event, which ghostty-web already handles.
        if (shortcut === 'native-paste') return false
        if (event.metaKey && event.key.toLowerCase() === 'k') {
          current.clear()
          return true
        }
        // ⌘R is the app's rename shortcut (renameChat in shared/shortcuts.ts). ghostty-web prevents the
        // default of every modified letter key, so the native menu accelerator never fires; run it here.
        if (event.metaKey && event.key.toLowerCase() === 'r') {
          handleMenuCommand('rename-chat', useAppStore.getState, value => useAppStore.setState(value))
          return true
        }
        return false
      })
      // ghostty-web cancels every beforeinput on its host and reads IME text only from
      // compositionend, so text that arrives without a composition (emoji picker, dictation,
      // Electron's insertText) would be lost. Feed it to the shell here.
      host.addEventListener('beforeinput', insertText)
      themeObserver = new MutationObserver(() => { current.options.theme = terminalTheme() })
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-color-theme'] })
      terminalRef.current = terminal
      fitRef.current = fit
      setReady(true)
    }).catch(error => {
      setConnection('error')
      setConnectionError(errorText(error))
    })
    function insertText(event: Event): void {
      const input = event as InputEvent
      if (input.inputType === 'insertText' && input.data && !input.isComposing) terminal?.input(input.data, true)
    }
    return () => {
      disposed = true
      host.removeEventListener('beforeinput', insertText)
      themeObserver?.disconnect()
      terminalRef.current = null
      fitRef.current = null
      terminal?.dispose()
    }
  }, [surface.id])

  useEffect(() => {
    const terminal = terminalRef.current
    const fit = fitRef.current
    const host = hostRef.current
    if (!ready || !terminal || !fit || !host || !profileId) return
    const mine = (payload: { profileId?: string; profileGeneration?: number; sessionId: string }) =>
      payload.profileId === profileId && payload.profileGeneration === profileGeneration && payload.sessionId === surface.id
    const fitNow = () => fitIfLaidOut(host, fit)
    let chunks: string[] = []
    let frame: number | null = null
    const flush = () => {
      frame = null
      if (!chunks.length) return
      const batch = chunks.join('')
      chunks = []
      terminal.write(batch)
      for (const _query of batch.matchAll(DA1_QUERY)) window.agentsDock.terminal.write(profileId, profileGeneration, surface.id, DA1_RESPONSE)
    }
    const removeData = window.agentsDock.events.on('terminal:data', payload => {
      if (!mine(payload)) return
      chunks.push(payload.data)
      frame ??= window.requestAnimationFrame(flush)
    })
    const removeState = window.agentsDock.events.on('terminal:state', payload => {
      if (!mine(payload)) return
      setConnection(payload.state)
      setConnectionError(payload.error ?? null)
      if (payload.state === 'connected') {
        // The server replays the shell's scrollback on every attach; start from a clean screen
        // so a reconnect does not show it twice.
        terminal.reset()
        fitNow()
        // The server sized the pty from the connect request. A fit made while the link was still
        // opening (a hidden tab shown on a slow remote) never reached it, and fit() will not repeat it.
        window.agentsDock.terminal.resize(profileId, profileGeneration, surface.id, terminal.cols, terminal.rows)
        terminal.focus()
      }
    })
    const input = terminal.onData(data => window.agentsDock.terminal.write(profileId, profileGeneration, surface.id, data))
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
      if (frame !== null) window.cancelAnimationFrame(frame)
      chunks = []
      input.dispose()
      resized.dispose()
      removeData()
      removeState()
      void window.agentsDock.terminal.disconnect(profileId, profileGeneration, surface.id).catch(() => undefined)
    }
  }, [ready, profileId, profileGeneration, surface.id, surface.cwd, shellRun])

  useEffect(() => {
    if (!active || !ready) return
    const frame = window.requestAnimationFrame(() => {
      if (hostRef.current && fitRef.current) fitIfLaidOut(hostRef.current, fitRef.current)
      terminalRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active, ready])

  const starting = connection === 'connecting' || connection === 'reconnecting'
  return <div className="terminal-surface">
    <div ref={hostRef} className="terminal-surface-host" />
    {connection !== 'connected' && <div className="terminal-surface-notice" role="status">
      <span>{starting ? t('surface.terminal.connecting') : connectionError ?? t('surface.terminal.exited')}</span>
      {!starting && <button type="button" className="quiet-button" onClick={() => setShellRun(run => run + 1)}>
        {connection === 'error' ? t('surface.terminal.retry') : t('surface.terminal.newShell')}
      </button>}
    </div>}
  </div>
}

// A host still being laid out can measure a few pixels; FitAddon would clamp that to its minimum grid and push it to the shell.
function fitIfLaidOut(host: HTMLElement, fit: FitAddon): void {
  const bounds = host.getBoundingClientRect()
  if (bounds.width >= 32 && bounds.height >= 32) fit.fit()
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
