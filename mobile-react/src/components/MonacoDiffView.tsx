import { useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'
import { MONACO_DIFF_HTML } from '../editor/monacoDiffAssets'
import type { DiffFile } from '../lib/code-review'
import { buildMonacoDiffModel } from '../lib/monaco-diff-model'
import { fonts } from '../lib/typography'
import { useAppColorScheme, usePalette } from '../theme'
import { Text } from './AppText'
import { Loading } from './ui'

const MONACO_DIFF_BASE_URL = 'https://agentsdock.local/monaco-diff/'
// One shared object: a fresh `source` identity makes the WebView reload the whole page.
const MONACO_DIFF_SOURCE = { html: MONACO_DIFF_HTML, baseUrl: MONACO_DIFF_BASE_URL }
const FONT_SIZE = 12

export function MonacoDiffView({ file, path, sideBySide, wordWrap, gapLabel }: {
  file: DiffFile
  path: string
  sideBySide: boolean
  wordWrap: boolean
  gapLabel: (unchanged: number | null) => string
}) {
  const colors = usePalette()
  const theme = useAppColorScheme()
  const model = useMemo(() => buildMonacoDiffModel(file, gapLabel), [file, gapLabel])
  const webViewRef = useRef<WebView>(null)
  // `ready` is the page's one-time boot signal; an error can arrive before or after it.
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const options = { sideBySide, wordWrap, theme }
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (!ready || !model) return
    // The load carries the current options so a file switch starts consistent;
    // a failed earlier file must not keep its message over the new one.
    setError(null)
    webViewRef.current?.postMessage(JSON.stringify({ type: 'load', path, ...model, ...optionsRef.current, fontSize: FONT_SIZE }))
  }, [ready, model, path])

  useEffect(() => {
    if (ready) webViewRef.current?.postMessage(JSON.stringify({ type: 'options', sideBySide, wordWrap, theme }))
  }, [ready, sideBySide, wordWrap, theme])

  const receive = (event: WebViewMessageEvent) => {
    let message: { type?: unknown; message?: unknown }
    try { message = JSON.parse(event.nativeEvent.data) } catch { return }
    if (message.type === 'ready') setReady(true)
    else if (message.type === 'error') setError(typeof message.message === 'string' && message.message ? message.message : 'unknown error')
  }

  // Header-only files (binary, mode changes) have no rows to diff; the page
  // stays mounted underneath so the next file does not pay for a reboot.
  const note = model ? null : file.lines.map(line => line.text).filter(Boolean).join('\n') || 'This file has no line-level changes to show.'
  return (
    <View style={[styles.root, { backgroundColor: colors.surface }]}>
      <WebView
        ref={webViewRef}
        testID="monaco-diff-webview"
        source={MONACO_DIFF_SOURCE}
        originWhitelist={['about:blank', 'https://agentsdock.local']}
        javaScriptEnabled
        domStorageEnabled={false}
        cacheEnabled={false}
        incognito
        mixedContentMode="never"
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        // Monaco scrolls its own viewport in both axes; the WebView's scroll view must not take the gesture first.
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        style={[styles.webView, { backgroundColor: colors.surface }]}
        onMessage={receive}
        onShouldStartLoadWithRequest={navigation => navigation.url === 'about:blank' || navigation.url.startsWith(MONACO_DIFF_BASE_URL)}
        onError={event => setError(event.nativeEvent.description || 'The diff editor page failed to load.')}
        onContentProcessDidTerminate={() => setError('The diff editor process stopped unexpectedly.')}
        onRenderProcessGone={() => setError('The diff editor renderer stopped unexpectedly.')}
      />
      {note !== null ? <View style={[styles.overlay, { backgroundColor: colors.surface }]}><Text selectable style={[styles.note, { color: colors.muted }]}>{note}</Text></View>
        : error ? <View style={[styles.overlay, { backgroundColor: colors.surface }]}><Text selectable style={[styles.note, { color: colors.red }]}>The diff editor could not render this file — {error}</Text></View>
          : !ready ? <View style={[styles.overlay, { backgroundColor: colors.surface }]}><Loading label="Loading diff editor" /></View>
            : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  webView: { flex: 1 },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, padding: 16 },
  note: { fontFamily: fonts.mono, fontSize: 12, lineHeight: 17 },
})
