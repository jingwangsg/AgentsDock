import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Alert, Linking, type NativeSyntheticEvent } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { TERMINAL_PAGE_JS, XTERM_CSS } from '../../terminal/xtermAssets'
import { PROMPT_GLYPH_FONT_FAMILY, PROMPT_GLYPH_FONT_TTF_BASE64 } from '../../terminal/promptGlyphFont'
import type { TerminalPageApi, TerminalPageConfig, TerminalPageMessage, TerminalPageOptions } from '../../terminal/terminalPage'
import type { TerminalConnectionStatus, TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

export type { TerminalConnectionStatus, TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

type CopyRequest = {
  id: number
  resolve: (copied: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export const TerminalViewport = forwardRef<TerminalViewportHandle, TerminalViewportProps>(function TerminalViewport({
  socketURL,
  backgroundHex,
  foregroundHex,
  cursorHex,
  selectionHex,
  fontSize = 13,
  onStatus,
  onModifiers,
  standalone = false,
  exited = false,
  dark = true,
  cursorStyle = 'bar',
  cursorBlink = true,
  scrollback = 10_000,
  screenReader = false,
  copyOnSelect = false,
  onPageEvent,
  ...viewProps
}, ref) {
  const webView = useRef<WebView>(null)
  const copySequence = useRef(0)
  const pendingCopy = useRef<CopyRequest | null>(null)
  const [webViewKey, setWebViewKey] = useState(0)
  const options = useMemo<TerminalPageOptions>(() => ({
    background: backgroundHex, foreground: foregroundHex, cursor: cursorHex, selection: selectionHex, dark,
    fontSize, cursorStyle, cursorBlink, scrollback, screenReader, copyOnSelect,
  }), [backgroundHex, copyOnSelect, cursorBlink, cursorHex, cursorStyle, dark, fontSize, foregroundHex, scrollback, screenReader, selectionHex])
  const optionsRef = useRef(options)
  const exitedRef = useRef(exited)
  exitedRef.current = exited
  // The page starts with what holds when it loads; later changes are applied in place, so a theme switch
  // or a font size change keeps the connection and the screen.
  const html = useMemo(
    () => androidTerminalHTML({
      socketURL, standalone, fontFamily: `monospace, "${PROMPT_GLYPH_FONT_FAMILY}"`, options: optionsRef.current, exited: exitedRef.current,
    }),
    [socketURL, standalone, webViewKey],
  )

  const inject = (script: string): boolean => {
    if (!webView.current) return false
    webView.current.injectJavaScript(`${script};true;`)
    return true
  }
  const call = <K extends keyof TerminalPageApi>(method: K, ...args: Parameters<TerminalPageApi[K]>) =>
    inject(`window.__agentsDockTerminal?.${method}(${args.map(safeInlineJSON).join(',')})`)

  // Calls made before the page finished loading are lost; it reports `ready` and gets them again then.
  useEffect(() => {
    if (optionsRef.current === options) return
    optionsRef.current = options
    call('configure', options)
  }, [options])

  const paste = async () => {
    const text = await Clipboard.getStringAsync()
    if (!text) return false
    return call('paste', text)
  }
  useImperativeHandle(ref, () => ({
    focus: async () => {
      // The page's focus() moves focus inside the web view only; after a native field (the find bar)
      // had it, the keys and the soft keyboard still go there until the web view itself asks.
      webView.current?.requestFocus()
      return call('focus')
    },
    blur: async () => call('blur'),
    paste,
    sendKey: async name => call('key', name),
    setModifier: async (name, active) => call('modifier', name, active),
    find: async (query, findOptions, direction, incremental) => call('find', query, findOptions, direction, incremental),
    clearFind: async () => call('clearFind'),
    jumpPrompt: async direction => call('jumpPrompt', direction),
    selectText: async on => call('selectText', on),
    restart: async () => call('restart'),
    copy: () => new Promise(resolve => {
      if (pendingCopy.current) {
        clearTimeout(pendingCopy.current.timer)
        pendingCopy.current.resolve(false)
      }
      const id = ++copySequence.current
      const timer = setTimeout(() => {
        if (pendingCopy.current?.id !== id) return
        pendingCopy.current = null
        resolve(false)
      }, 900)
      pendingCopy.current = { id, resolve, timer }
      if (!call('copy', id)) {
        clearTimeout(timer)
        pendingCopy.current = null
        resolve(false)
      }
    }),
  }), [])

  useEffect(() => () => {
    if (!pendingCopy.current) return
    clearTimeout(pendingCopy.current.timer)
    pendingCopy.current.resolve(false)
    pendingCopy.current = null
  }, [])

  const emitStatus = (status: TerminalConnectionStatus) => {
    onStatus?.({ nativeEvent: status } as NativeSyntheticEvent<TerminalConnectionStatus>)
  }
  const handleMessage = (event: WebViewMessageEvent) => {
    let message: TerminalPageMessage
    try {
      message = JSON.parse(event.nativeEvent.data) as TerminalPageMessage
    } catch {
      return
    }
    switch (message.type) {
      case 'ready':
        call('configure', optionsRef.current)
        return
      case 'status':
        emitStatus({ status: message.status, name: message.name, message: message.message })
        return
      case 'modifiers':
        onModifiers?.({ ctrl: message.ctrl === true, alt: message.alt === true })
        return
      case 'copy': {
        const pending = pendingCopy.current
        if (!pending || message.requestId !== pending.id) return
        pendingCopy.current = null
        clearTimeout(pending.timer)
        if (!message.text) {
          pending.resolve(false)
          return
        }
        void Clipboard.setStringAsync(message.text).then(() => pending.resolve(true), () => pending.resolve(false))
        return
      }
      case 'clipboard':
        if (typeof message.text === 'string') void Clipboard.setStringAsync(message.text).catch(() => undefined)
        return
      case 'link': {
        // The page offers only http(s) links; the web view itself never navigates. Any program can make any
        // text a link (OSC 8), so a tap shows where it goes first, as the desktop asks for ⌘-click.
        const uri = message.uri
        if (!/^https?:\/\//i.test(uri)) return
        Alert.alert('Open link?', uri, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open', onPress: () => { void Linking.openURL(uri).catch(() => undefined) } },
        ])
        return
      }
      case 'command':
        if (message.command === 'paste') void paste()
        else onPageEvent?.(message)
        return
      default:
        onPageEvent?.(message)
    }
  }

  return <WebView
    {...viewProps}
    key={`${socketURL}:${webViewKey}`}
    ref={webView}
    testID="terminal-android-webview"
    source={{ html, baseUrl: 'https://agentsdock.invalid/' }}
    originWhitelist={['https://agentsdock.invalid/']}
    javaScriptEnabled
    domStorageEnabled={false}
    cacheEnabled={false}
    incognito
    mixedContentMode="always"
    setSupportMultipleWindows={false}
    javaScriptCanOpenWindowsAutomatically={false}
    scrollEnabled={false}
    overScrollMode="never"
    onShouldStartLoadWithRequest={request => request.url === 'https://agentsdock.invalid/' || request.url === 'about:blank'}
    onMessage={handleMessage}
    onError={event => emitStatus({ status: 'Error', message: event.nativeEvent.description || 'Android terminal failed to load.' })}
    onRenderProcessGone={() => {
      emitStatus({ status: 'Reconnecting', message: 'Restarting Android terminal renderer…' })
      setWebViewKey(value => value + 1)
      return true
    }}
  />
})

export function androidTerminalHTML(config: TerminalPageConfig): string {
  // load-bearing: a "</script" anywhere in the bundle (a string in some dependency) would end the inline script.
  const script = escapeClosingTag(TERMINAL_PAGE_JS, 'script')
  const css = escapeClosingTag(XTERM_CSS, 'style')
  // Bundled fallback so xterm's per-glyph fallback can cover powerline/PUA glyphs
  // that Android system monospace fonts lack. The base64 is [A-Za-z0-9+/=] only,
  // so it needs no </style> escaping; font-src data: in the CSP admits it.
  const promptFont = `@font-face{font-family:"${PROMPT_GLYPH_FONT_FAMILY}";src:url("data:font/ttf;base64,${PROMPT_GLYPH_FONT_TTF_BASE64}") format("truetype")}`
  // 'wasm-unsafe-eval': the image addon decodes sixel in WebAssembly. blob: images: its iTerm2 image fallback.
  // touch-action none: the page runs every touch gesture on the terminal itself; the selectable text layer
  // keeps the web view's own scrolling and selection. A transparent viewport: xterm.css paints it black
  // under the padding, a frame around the terminal in the light theme.
  return `<!doctype html><html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ws: wss:; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'wasm-unsafe-eval'">
  <style>${css}\n${promptFont}\nhtml,body,#terminal{width:100%;height:100%;margin:0;background:${config.options.background};overflow:hidden}#terminal{touch-action:none}.xterm{padding:8px;box-sizing:border-box}.xterm .xterm-viewport{background-color:transparent}#select-layer{display:none;position:fixed;inset:0;z-index:10;overflow-y:auto;padding:8px;box-sizing:border-box;margin:0;white-space:pre-wrap;word-break:break-all;line-height:1.2;user-select:text;-webkit-user-select:text;touch-action:pan-y}</style>
  </head><body><div id="terminal"></div><script>window.__agentsDockTerminalConfig=${safeInlineJSON(config)}</script><script>${script}</script></body></html>`
}

export function safeInlineJSON(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeClosingTag(value: string, tag: 'script' | 'style'): string {
  return value.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
}
