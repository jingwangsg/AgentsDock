// Android PDF preview: the offline pdf.js page from scripts/pdf-viewer-entry.ts
// in a locked-down WebView. iOS keeps its WebView's native PDF rendering.
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import * as FileSystem from 'expo-file-system/legacy'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'
import { PDF_VIEWER_HTML } from '../../editor/pdfViewerAssets'
import { usePalette } from '../../theme'
import { Text } from '../AppText'
import { Loading } from '../ui'

const PDF_VIEWER_BASE_URL = 'https://agentsdock.local/pdf-viewer/'
// One shared object: a fresh `source` identity makes the WebView reload the whole page.
const PDF_VIEWER_SOURCE = { html: PDF_VIEWER_HTML, baseUrl: PDF_VIEWER_BASE_URL }
// A multiple of 3, so every chunk's base64 decodes on its own in the page.
const CHUNK_BYTES = 3 * 1024 * 1024
// pdf.js holds the whole file in the WebView and parses it on the page's only thread.
const PDF_PREVIEW_MAX_BYTES = 64 * 1024 * 1024

/** Renders a PDF already downloaded to `uri`; keyed by the caller per file. */
export function PdfDocumentView({ uri, onError }: { uri: string; onError: (message: string) => void }) {
  const colors = usePalette()
  const webViewRef = useRef<WebView>(null)
  const [ready, setReady] = useState(false)
  const [position, setPosition] = useState<{ page: number; pages: number } | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const backgroundRef = useRef(colors.background)
  backgroundRef.current = colors.background

  const post = (message: object) => webViewRef.current?.postMessage(JSON.stringify(message))

  // Stream the file once the page listens: begin, 3 MiB base64 chunks, end.
  useEffect(() => {
    if (!ready) return
    let current = true
    void (async () => {
      const info = await FileSystem.getInfoAsync(uri)
      if (!info.exists) throw new Error('The downloaded PDF is no longer on this device.')
      if (info.size > PDF_PREVIEW_MAX_BYTES) throw new Error(`This PDF is larger than the ${PDF_PREVIEW_MAX_BYTES / 1024 / 1024} MB in-app preview limit.`)
      if (!current) return
      post({ type: 'begin', size: info.size, background: backgroundRef.current })
      for (let offset = 0; offset < info.size; offset += CHUNK_BYTES) {
        const data = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
          position: offset,
          length: Math.min(CHUNK_BYTES, info.size - offset),
        })
        if (!current) return
        post({ type: 'chunk', offset, data })
      }
      post({ type: 'end' })
    })().catch(error => {
      if (current) onErrorRef.current(error instanceof Error ? error.message : String(error))
    })
    return () => { current = false }
  }, [ready, uri])

  useEffect(() => {
    if (ready) post({ type: 'theme', background: colors.background })
  }, [ready, colors.background])

  const receive = (event: WebViewMessageEvent) => {
    let message: { type?: unknown; message?: unknown; page?: unknown; pages?: unknown }
    try { message = JSON.parse(event.nativeEvent.data) } catch { return }
    if (message.type === 'ready') setReady(true)
    else if (message.type === 'loaded' && typeof message.pages === 'number') setPosition({ page: 1, pages: message.pages })
    else if (message.type === 'page' && typeof message.page === 'number' && typeof message.pages === 'number') setPosition({ page: message.page, pages: message.pages })
    else if (message.type === 'error') onErrorRef.current(typeof message.message === 'string' && message.message ? message.message : 'The PDF viewer failed.')
  }

  return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <WebView
      ref={webViewRef}
      testID="file-viewer-pdf"
      source={PDF_VIEWER_SOURCE}
      originWhitelist={['about:blank', 'https://agentsdock.local']}
      javaScriptEnabled
      domStorageEnabled={false}
      cacheEnabled={false}
      incognito
      mixedContentMode="never"
      allowFileAccess={false}
      allowUniversalAccessFromFileURLs={false}
      setSupportMultipleWindows={false}
      // The text layer is sized in CSS pixels; Android's font-size setting would enlarge it off the glyphs.
      textZoom={100}
      setBuiltInZoomControls
      setDisplayZoomControls={false}
      overScrollMode="never"
      style={{ backgroundColor: colors.background }}
      onMessage={receive}
      onShouldStartLoadWithRequest={navigation => navigation.url === 'about:blank' || navigation.url.startsWith(PDF_VIEWER_BASE_URL)}
      onError={event => onErrorRef.current(event.nativeEvent.description || 'The PDF viewer page failed to load.')}
      onRenderProcessGone={() => onErrorRef.current('The PDF viewer stopped unexpectedly; the file may be too large to render.')}
    />
    {!position ? <View style={[styles.overlay, { backgroundColor: colors.background }]}><Loading label="Rendering PDF" /></View> : null}
    {position && position.pages > 1 ? <View pointerEvents="none" style={[styles.pageBadge, { backgroundColor: colors.raised, borderColor: colors.border }]}>
      <Text style={[styles.pageBadgeText, { color: colors.text }]}>{position.page} / {position.pages}</Text>
    </View> : null}
  </View>
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  pageBadge: { position: 'absolute', bottom: 12, alignSelf: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 4 },
  pageBadgeText: { fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
})
