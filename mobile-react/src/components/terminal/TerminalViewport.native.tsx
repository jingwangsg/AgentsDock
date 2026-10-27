import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Linking, Platform, StyleSheet, type NativeSyntheticEvent } from 'react-native'
import { Alert } from '../../lib/alert'
import * as Clipboard from 'expo-clipboard'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { TextInput } from '../AppText'
import { TERMINAL_PAGE_JS, XTERM_CSS } from '../../terminal/xtermAssets'
import { PROMPT_GLYPH_FONT_FAMILY, PROMPT_GLYPH_FONT_TTF_BASE64 } from '../../terminal/promptGlyphFont'
import { TERMINAL_FONT_FACE, TERMINAL_FONT_FAMILY } from '../../terminal/terminalFont'
import type { TerminalPageApi, TerminalPageConfig, TerminalPageMessage, TerminalPageOptions } from '../../terminal/terminalPage'
import type { TerminalConnectionStatus, TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

export type { TerminalConnectionStatus, TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

// load-bearing: WebKit blocks a ws:// connection from an https: page and has no mixed-content switch, so the
// iOS page is http:. Nothing in the page needs a secure context. Android keeps the https: page with mixedContentMode.
const PAGE_URL = Platform.OS === 'ios' ? 'http://agentsdock.invalid/' : 'https://agentsdock.invalid/'
// load-bearing: on iOS any focus in the page raises the soft keyboard (keyboardDisplayRequiresUserAction), on
// Android an injected one does not. A key-row key or Paste must not bring back a keyboard the user put away.
const FOCUS_ON_INPUT = Platform.OS !== 'ios'

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
  visible = true,
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
  const keyboardBridge = useRef<TextInput>(null)
  const copySequence = useRef(0)
  const pendingCopy = useRef<CopyRequest | null>(null)
  const [webViewKey, setWebViewKey] = useState(0)
  const options = useMemo<TerminalPageOptions>(() => ({
    background: backgroundHex, foreground: foregroundHex, cursor: cursorHex, selection: selectionHex, dark,
    fontSize, cursorStyle, cursorBlink, scrollback, screenReader, copyOnSelect,
  }), [backgroundHex, copyOnSelect, cursorBlink, cursorHex, cursorStyle, dark, fontSize, foregroundHex, scrollback, screenReader, selectionHex])
  const optionsRef = useRef(options)
  const visibleRef = useRef(visible)
  const exitedRef = useRef(exited)
  exitedRef.current = exited
  // The page starts with what holds when it loads; later changes are applied in place, so a theme switch,
  // a font size change or hiding the tab keeps the connection and the screen.
  const html = useMemo(
    () => terminalHTML({
      socketURL, standalone, fontFamily: `${TERMINAL_FONT_FAMILY}, "${PROMPT_GLYPH_FONT_FAMILY}"`, options: optionsRef.current, visible: visibleRef.current, exited: exitedRef.current,
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

  // Calls made before the page finished loading are lost; it reports `ready` and gets both again then.
  useEffect(() => {
    if (optionsRef.current === options) return
    optionsRef.current = options
    call('configure', options)
  }, [options])
  useEffect(() => {
    if (visibleRef.current === visible) return
    visibleRef.current = visible
    call('setVisible', visible)
  }, [visible])

  const paste = async () => {
    const text = await Clipboard.getStringAsync()
    if (!text) return false
    return call('paste', text, FOCUS_ON_INPUT)
  }
  useImperativeHandle(ref, () => ({
    focus: async () => {
      // Blink raises the soft keyboard only for a focus made by a user gesture in the page, and injected
      // script carries none. A keyboard shown for a native field stays up when the focus moves on to the
      // page's editor, so the keyboard comes up through a hidden field first. The page's focus() alone moves
      // focus inside the web view only, so the web view asks for it as well. WebKit shows the keyboard for the
      // page's focus itself (keyboardDisplayRequiresUserAction), so iOS has no hidden field.
      keyboardBridge.current?.focus()
      webView.current?.requestFocus()
      return call('focus')
    },
    blur: async () => call('blur'),
    paste,
    sendKey: async name => call('key', name, FOCUS_ON_INPUT),
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
        call('setVisible', visibleRef.current)
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

  const restartRenderer = () => {
    emitStatus({ status: 'Reconnecting', message: 'Restarting terminal renderer…' })
    setWebViewKey(value => value + 1)
    return true
  }

  return <><WebView
    {...viewProps}
    key={`${socketURL}:${webViewKey}`}
    ref={webView}
    testID="terminal-webview"
    source={{ html, baseUrl: PAGE_URL }}
    // An origin has no trailing slash. iOS checks the page's own first load against it; a miss opens it in Safari.
    originWhitelist={[PAGE_URL.slice(0, -1)]}
    javaScriptEnabled
    domStorageEnabled={false}
    cacheEnabled={false}
    incognito
    mixedContentMode="always"
    setSupportMultipleWindows={false}
    javaScriptCanOpenWindowsAutomatically={false}
    scrollEnabled={false}
    overScrollMode="never"
    onShouldStartLoadWithRequest={request => request.url === PAGE_URL || request.url === 'about:blank'}
    // iOS: the page focuses its own text field, the key row sits right on the keyboard (no ‹ › Done bar), and
    // iPad gets the phone's key handling, where Option is Alt as on Android, not the desktop-class Mac one.
    keyboardDisplayRequiresUserAction={false}
    hideKeyboardAccessoryView
    contentMode="mobile"
    bounces={false}
    webviewDebuggingEnabled={__DEV__}
    onMessage={handleMessage}
    onError={event => emitStatus({ status: 'Error', message: event.nativeEvent.description || 'Terminal failed to load.' })}
    onRenderProcessGone={restartRenderer}
    onContentProcessDidTerminate={restartRenderer}
  />
  {Platform.OS === 'android' ? <TextInput
    ref={keyboardBridge}
    value=""
    caretHidden
    autoCorrect={false}
    accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants"
    style={styles.keyboardBridge}
  /> : null}</>
})

const styles = StyleSheet.create({
  keyboardBridge: { position: 'absolute', top: 0, left: 0, width: 1, height: 1, opacity: 0 },
})

export function terminalHTML(config: TerminalPageConfig): string {
  // load-bearing: a "</script" anywhere in the bundle (a string in some dependency) would end the inline script.
  const script = escapeClosingTag(TERMINAL_PAGE_JS, 'script')
  const css = escapeClosingTag(XTERM_CSS, 'style')
  // xterm.js measures its cell once, when it opens, and a bundled font (iOS) loads asynchronously: the page starts
  // once it has loaded, or the cell keeps the fallback font's width.
  const page = TERMINAL_FONT_FACE ? `document.fonts.load('1em ${TERMINAL_FONT_FAMILY}').finally(function(){${script}})` : script
  // iOS: WebKit enlarges text in landscape unless told not to, which would change xterm's cell and the select layer.
  const textSizeAdjust = Platform.OS === 'ios' ? 'html{-webkit-text-size-adjust:100%}' : ''
  // Bundled fallback so xterm's per-glyph fallback can cover powerline/PUA glyphs
  // that the terminal's monospace font lacks. The base64 is [A-Za-z0-9+/=] only,
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
  <style>${css}\n${TERMINAL_FONT_FACE}${promptFont}\n${textSizeAdjust}html,body,#terminal{width:100%;height:100%;margin:0;background:${config.options.background};overflow:hidden}#terminal{touch-action:none}.xterm{padding:8px;box-sizing:border-box}.xterm .xterm-viewport{background-color:transparent}#select-layer{display:none;position:fixed;inset:0;z-index:10;overflow-y:auto;padding:8px;box-sizing:border-box;margin:0;white-space:pre-wrap;word-break:break-all;line-height:1.2;user-select:text;-webkit-user-select:text;touch-action:pan-y}</style>
  </head><body><div id="terminal"></div><script>window.__agentsDockTerminalConfig=${safeInlineJSON(config)}</script><script>${page}</script></body></html>`
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
