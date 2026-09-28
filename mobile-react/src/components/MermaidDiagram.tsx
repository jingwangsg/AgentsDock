import { useEffect, useRef, useState, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'
import { fonts } from '../lib/typography'
import { useAppColorScheme, usePalette } from '../theme'
import { Text } from './AppText'
import { MERMAID_HTML } from './mermaidAssets'

const MERMAID_BASE_URL = 'https://agentsdock.local/mermaid/'
// One shared object: a fresh `source` identity makes the WebView reload the whole page.
const MERMAID_SOURCE = { html: MERMAID_HTML, baseUrl: MERMAID_BASE_URL }
// Streamed chat text changes on every chunk and a half-written definition parses as an error.
const RENDER_IDLE_MS = 400

type RenderState = { status: 'loading' } | { status: 'rendered'; height: number } | { status: 'error'; message: string }

export function MermaidDiagram({ source, children }: { source: string; children: ReactNode }) {
  const colors = usePalette()
  const theme = useAppColorScheme() === 'light' ? 'default' : 'dark'
  const webViewRef = useRef<WebView>(null)
  const readyRef = useRef(false)
  const [state, setState] = useState<RenderState>({ status: 'loading' })
  const request = JSON.stringify({ type: 'render', source, theme })
  const requestRef = useRef(request)
  requestRef.current = request
  useEffect(() => {
    const timer = setTimeout(() => { if (readyRef.current) webViewRef.current?.postMessage(request) }, RENDER_IDLE_MS)
    return () => clearTimeout(timer)
  }, [request])
  const receive = (event: WebViewMessageEvent) => {
    let message: { type?: unknown; height?: unknown; message?: unknown }
    try { message = JSON.parse(event.nativeEvent.data) } catch { return }
    if (message.type === 'ready') {
      // The page boots after the first request was due, so it is sent now instead of waiting for the next change.
      readyRef.current = true
      webViewRef.current?.postMessage(requestRef.current)
    } else if (message.type === 'rendered' && typeof message.height === 'number') {
      setState({ status: 'rendered', height: Math.max(1, message.height) })
    } else if (message.type === 'error') {
      setState({ status: 'error', message: typeof message.message === 'string' ? message.message : '' })
    }
  }
  return (
    <View>
      {/* Kept mounted at 1 pt while loading or failed so the next definition renders into the same page. */}
      <View style={state.status === 'rendered' ? { height: state.height, marginBottom: 10 } : styles.hidden}>
        <WebView
          ref={webViewRef}
          testID="mermaid-diagram-webview"
          source={MERMAID_SOURCE}
          originWhitelist={['about:blank', 'https://agentsdock.local']}
          javaScriptEnabled
          domStorageEnabled={false}
          cacheEnabled={false}
          incognito
          mixedContentMode="never"
          allowFileAccess={false}
          allowUniversalAccessFromFileURLs={false}
          setSupportMultipleWindows={false}
          scrollEnabled={false}
          overScrollMode="never"
          style={styles.webView}
          onMessage={receive}
          onShouldStartLoadWithRequest={navigation => navigation.url === 'about:blank' || navigation.url.startsWith(MERMAID_BASE_URL)}
          onError={event => setState({ status: 'error', message: event.nativeEvent.description || 'The diagram page failed to load.' })}
        />
      </View>
      {state.status !== 'rendered' ? children : null}
      {state.status === 'error' ? (
        <Text style={[styles.error, { color: colors.muted }]}>Mermaid could not render this diagram — {state.message}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  hidden: { height: 1, overflow: 'hidden' },
  webView: { backgroundColor: 'transparent' },
  error: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17, marginBottom: 10 },
})
