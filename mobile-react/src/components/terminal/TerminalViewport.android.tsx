import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { NativeSyntheticEvent } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import { TERMINAL_PAGE_JS, XTERM_CSS } from '../../terminal/xtermAssets'
import { PROMPT_GLYPH_FONT_FAMILY, PROMPT_GLYPH_FONT_TTF_BASE64 } from '../../terminal/promptGlyphFont'
import type { TerminalConnectionStatus, TerminalModifierState, TerminalViewportHandle, TerminalViewportProps } from './TerminalViewport.types'

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
  ...viewProps
}, ref) {
  const webView = useRef<WebView>(null)
  const copySequence = useRef(0)
  const pendingCopy = useRef<CopyRequest | null>(null)
  const [webViewKey, setWebViewKey] = useState(0)
  const html = useMemo(
    () => androidTerminalHTML({ socketURL, backgroundHex, foregroundHex, cursorHex, selectionHex, fontSize }),
    [backgroundHex, cursorHex, fontSize, foregroundHex, selectionHex, socketURL],
  )

  const inject = (script: string): boolean => {
    if (!webView.current) return false
    webView.current.injectJavaScript(`${script};true;`)
    return true
  }

  useImperativeHandle(ref, () => ({
    focus: async () => inject('window.__agentsDockTerminal?.focus()'),
    blur: async () => inject('window.__agentsDockTerminal?.blur()'),
    paste: async () => {
      const text = await Clipboard.getStringAsync()
      if (!text) return false
      return inject(`window.__agentsDockTerminal?.paste(${safeInlineJSON(text)})`)
    },
    sendKey: async name => inject(`window.__agentsDockTerminal?.key(${safeInlineJSON(name)})`),
    setModifier: async (name, active) => inject(`window.__agentsDockTerminal?.modifier(${safeInlineJSON(name)}, ${active ? 'true' : 'false'})`),
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
      if (!inject(`window.__agentsDockTerminal?.copy(${id})`)) {
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
    let value: { type?: string; status?: TerminalConnectionStatus['status']; name?: string; message?: string; text?: string; requestId?: number; ctrl?: boolean; alt?: boolean }
    try {
      value = JSON.parse(event.nativeEvent.data) as typeof value
    } catch {
      return
    }
    if (value.type === 'status' && value.status) {
      emitStatus({ status: value.status, name: value.name, message: value.message })
      return
    }
    if (value.type === 'modifiers') {
      onModifiers?.({ ctrl: value.ctrl === true, alt: value.alt === true } satisfies TerminalModifierState)
      return
    }
    const pending = pendingCopy.current
    if (value.type === 'copy' && pending && value.requestId === pending.id) {
      pendingCopy.current = null
      clearTimeout(pending.timer)
      if (!value.text) {
        pending.resolve(false)
        return
      }
      void Clipboard.setStringAsync(value.text).then(() => pending.resolve(true), () => pending.resolve(false))
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

interface AndroidTerminalConfig {
  socketURL: string
  backgroundHex: string
  foregroundHex: string
  cursorHex: string
  selectionHex: string
  fontSize: number
}

export function androidTerminalHTML(config: AndroidTerminalConfig): string {
  // load-bearing: a "</script" anywhere in the bundle (a string in some dependency) would end the inline script.
  const script = escapeClosingTag(TERMINAL_PAGE_JS, 'script')
  const css = escapeClosingTag(XTERM_CSS, 'style')
  // Bundled fallback so xterm's per-glyph fallback can cover powerline/PUA glyphs
  // that Android system monospace fonts lack. The base64 is [A-Za-z0-9+/=] only,
  // so it needs no </style> escaping; font-src data: in the CSP admits it.
  const promptFont = `@font-face{font-family:"${PROMPT_GLYPH_FONT_FAMILY}";src:url("data:font/ttf;base64,${PROMPT_GLYPH_FONT_TTF_BASE64}") format("truetype")}`
  return `<!doctype html><html><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ws: wss:; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
  <style>${css}\n${promptFont}\nhtml,body,#terminal{width:100%;height:100%;margin:0;background:${config.backgroundHex};overflow:hidden}.xterm{padding:8px;box-sizing:border-box}.xterm-viewport{overscroll-behavior:contain}</style>
  </head><body><div id="terminal"></div><script>window.__agentsDockTerminalConfig=${safeInlineJSON({ ...config, fontFamily: `monospace, "${PROMPT_GLYPH_FONT_FAMILY}"` })}</script><script>${script}</script></body></html>`
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
