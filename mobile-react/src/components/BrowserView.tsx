import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import WebView, { type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview'
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react-native'
import { releaseBrowserLoopback, routeBrowserLoopback } from 'agentsdock-browser-loopback'
import { browserAddressURL } from '../lib/surfaces'
import { client, useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { Surface } from '../types'
import { Text, TextInput } from './AppText'
import { IconButton } from './ui'

// Reports document.title after a page loads and whenever it retitles itself. The web view runs
// injected script only for pages that loaded, so its own error page never names the tab.
const REPORT_PAGE_TITLE = `(function () {
  var reported = null;
  function report() {
    if (document.title === reported) return;
    reported = document.title;
    window.ReactNativeWebView.postMessage(JSON.stringify({ agentsdockPageTitle: reported }));
  }
  report();
  new MutationObserver(report).observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
})();
true;`

/** A browser tab: a web view with an address bar; the tab record follows the page so other devices see where it is. */
export function BrowserView({ surface }: { surface: Surface }) {
  const colors = usePalette()
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const updateSurface = useAppStore(state => state.updateSurface)
  const view = useRef<WebView>(null)
  // Later navigation changes `uri`; the web view reloads only when it changes.
  const [uri, setUri] = useState(surface.url ?? '')
  const [address, setAddress] = useState(surface.url ?? '')
  const [history, setHistory] = useState({ canGoBack: false, canGoForward: false })
  // localhost is the selected server, as on the desktop; the page waits until that routing is in place.
  const [loopback, setLoopback] = useState<'pending' | 'routed' | 'unavailable'>('pending')
  useEffect(() => {
    let current = true
    const tunnel = new URL(client.url(`/api/sessions/${encodeURIComponent(surface.id)}/ports/`))
    tunnel.protocol = tunnel.protocol === 'https:' ? 'wss:' : 'ws:'
    const token = client.authHeaders()['X-ZenithDock-Token'] ?? ''
    routeBrowserLoopback(surface.id, tunnel.toString(), token)
      .then(routed => { if (current) setLoopback(routed ? 'routed' : 'unavailable') })
      .catch(() => { if (current) setLoopback('unavailable') })
    return () => {
      current = false
      void releaseBrowserLoopback(surface.id)
    }
  }, [surface.id])
  const navigated = (state: WebViewNavigation) => {
    setHistory({ canGoBack: state.canGoBack, canGoForward: state.canGoForward })
    if (!state.url || state.url === 'about:blank') return
    setAddress(state.url)
    if (!state.loading && state.url !== surface.url) void updateSurface(surface.id, { url: state.url }, profileGeneration)
  }
  const titled = (event: WebViewMessageEvent) => {
    let title: unknown
    try {
      title = (JSON.parse(event.nativeEvent.data) as { agentsdockPageTitle?: unknown }).agentsdockPageTitle
    } catch {
      return
    }
    const trimmed = typeof title === 'string' ? title.trim() : ''
    if (trimmed && trimmed !== surface.page_title) void updateSurface(surface.id, { page_title: trimmed }, profileGeneration)
  }
  const submit = () => {
    const next = browserAddressURL(address)
    if (next) setUri(next)
  }
  const localhostOnPhone = loopback === 'unavailable' && /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:|\/|$)/i.test(uri)
  return <View style={styles.root}>
    <View style={[styles.toolbar, { borderColor: colors.border, backgroundColor: colors.background }]}>
      <IconButton icon={ArrowLeft} size={16} label="Back" disabled={!history.canGoBack} onPress={() => view.current?.goBack()} />
      <IconButton icon={ArrowRight} size={16} label="Forward" disabled={!history.canGoForward} onPress={() => view.current?.goForward()} />
      <TextInput
        value={address}
        onChangeText={setAddress}
        onSubmitEditing={submit}
        placeholder="Enter a URL or search"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        selectTextOnFocus
        accessibilityLabel="Address"
        testID="browser-address"
        style={[styles.address, { color: colors.text, backgroundColor: colors.raised, borderColor: colors.border }]}
      />
      <IconButton icon={RotateCw} size={16} label="Reload" disabled={!uri} onPress={() => view.current?.reload()} />
    </View>
    {localhostOnPhone
      ? <Text style={[styles.notice, { color: colors.muted, borderColor: colors.border }]}>This phone's web view cannot reach the server's localhost; localhost here is the phone.</Text>
      : null}
    {uri && loopback !== 'pending'
      ? <WebView
          ref={view}
          source={{ uri }}
          onNavigationStateChange={navigated}
          injectedJavaScript={REPORT_PAGE_TITLE}
          onMessage={titled}
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures
          style={styles.web}
        />
      : <View style={styles.empty}>{uri ? null : <Text style={{ color: colors.muted, fontSize: 13 }}>Enter an address above to open a page.</Text>}</View>}
  </View>
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  toolbar: { minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 6, paddingVertical: 4, flexDirection: 'row', alignItems: 'center', gap: 2 },
  address: { flex: 1, minHeight: 36, marginHorizontal: 4, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 0, fontSize: 14 },
  notice: { paddingHorizontal: 12, paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, fontSize: 12 },
  web: { flex: 1 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
})
