import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const sheet = source('src/components/CanvasSheet.tsx')
const page = source('src/lib/canvas-page.ts')
const links = source('src/lib/canvas-links.ts')
const markdown = source('src/components/MarkdownContent.tsx')
const chatScreen = source('src/components/ChatScreen.tsx')
const panel = source('src/components/ChatOutputsPanel.tsx')
const collector = source('src/lib/chat-outputs.ts')
const client = source('src/api/AgentServerClient.ts')
const types = source('src/types.ts')

test('the client exposes the canvas routes with the desktop record types', () => {
  assert.match(types, /export interface CanvasSummary \{\n  name: string\n  path: string\n  revision: number\n  size: number\n  updated_at: string\n\}/)
  assert.match(types, /export interface CanvasRecord extends Omit<CanvasSummary, 'size'> \{[\s\S]*?javascript: string\n  diagnostics: string \| null\n  runtime_version: string \| null\n  state: Record<string, unknown>/)
  assert.match(client, /listCanvases\(sessionId: string\): Promise<\{ canvases: CanvasSummary\[\] \}>/)
  assert.match(client, /getCanvas\(sessionId: string, name: string\): Promise<CanvasRecord>/)
  assert.match(client, /putCanvasState\(sessionId: string, name: string, state: Record<string, unknown>\)/)
  assert.match(client, /async canvasRuntimeAsset\(asset: 'shell\.html' \| 'vendor\.js'\): Promise<string>/)
  assert.match(client, /`\/api\/canvas-runtime\/\$\{asset\}`/)
})

test('the sheet is a page sheet with the canvas name, a switcher, reload and close', () => {
  assert.match(sheet, /<Modal visible=\{name !== null\} animationType="slide" presentationStyle=\{Platform\.OS === 'ios' \? 'pageSheet' : 'fullScreen'\} allowSwipeDismissal onRequestClose=\{onClose\}>/)
  assert.match(sheet, /Canvas · \{name\}/)
  assert.match(sheet, /\{canvases\.length > 1 \? <ScrollView horizontal/, 'the switcher appears only when the chat has several canvases')
  assert.match(sheet, /<IconButton icon=\{RefreshCw\} size=\{16\} label="Reload canvas" testID="canvas-reload"/)
  assert.match(sheet, /<SheetCloseButton onPress=\{onClose\} label="Close canvas" testID="canvas-close" \/>/)
})

test('the WebView renders a page assembled in-app the way the desktop protocol handler does', () => {
  assert.match(sheet, /import WebView, \{ type WebViewMessageEvent \} from 'react-native-webview'/)
  assert.match(sheet, /buildCanvasPage\(\{ shell: runtime\.shell, vendor: runtime\.vendor, javascript: compiled\.javascript, state: stateRef\.current, theme \}\), baseUrl: CANVAS_PAGE_BASE_URL/)
  assert.match(sheet, /const CANVAS_PAGE_BASE_URL = 'about:blank'/)
  assert.match(sheet, /originWhitelist=\{\[CANVAS_PAGE_BASE_URL\]\}/)
  assert.match(sheet, /javaScriptEnabled/)
  assert.match(sheet, /onMessage=\{receive\}/)
  assert.match(sheet, /onShouldStartLoadWithRequest=\{navigation => navigation\.url === CANVAS_PAGE_BASE_URL\}/)
  // vendor.js and shell.html download once per runtime version.
  assert.match(sheet, /const runtimeAssets = new Map<string, Promise<\{ shell: string; vendor: string \}>>\(\)/)
  assert.match(sheet, /client\.canvasRuntimeAsset\('shell\.html'\), client\.canvasRuntimeAsset\('vendor\.js'\)/)
  // The theme follows the app colour scheme.
  assert.match(sheet, /const scheme = useAppColorScheme\(\)/)
  assert.match(sheet, /accent: colors\.blue, kind: scheme/)
  // Script order and the bridge target live in the pure module.
  assert.match(page, /\[BRIDGE_SHIM, input\.vendor, input\.javascript, mount\]/)
  assert.match(page, /window\.ReactNativeWebView\.postMessage\(JSON\.stringify\(\{ source: PAGE, message \}\)\)/)
  assert.match(page, /data:application\/javascript;base64,/)
})

test('runtime messages persist state with a debounce and surface errors with a source fallback', () => {
  assert.match(sheet, /const STATE_SAVE_DELAY_MS = 400/)
  assert.match(sheet, /case 'state':[\s\S]*?pendingSave\.current = \{ name, state: stateRef\.current \}[\s\S]*?setTimeout\(\(\) => \{ void flushSave\(\) \}, STATE_SAVE_DELAY_MS\)/)
  assert.match(sheet, /client\.putCanvasState\(sessionId, pending\.name, pending\.state\)/)
  assert.match(sheet, /useEffect\(\(\) => \(\) => \{ void flushSave\(\) \}, \[flushSave, name\]\)/, 'switching or closing flushes the last change')
  assert.match(sheet, /case 'error':\s+setPageError\(message\.error\)/)
  assert.match(sheet, /<Notice title="The canvas reported an error" detail=\{pageError\} action=\{showSourceAction\} \/>/)
  assert.match(sheet, /const showSourceAction = \{ label: 'Show source', onPress: \(\) => setShowSource\(true\) \}/)
  assert.match(sheet, /<Text selectable testID="canvas-source" style=\{\[styles\.code, \{ color: colors\.text \}\]\}>\{record\.source\}<\/Text>/)
  assert.match(sheet, /code: \{ fontFamily: fonts\.mono/)
  // A compile failure shows the diagnostics instead of an empty page.
  assert.match(sheet, /const compiled = record && !record\.diagnostics && record\.javascript \? record : null/)
  assert.match(sheet, /<Notice title="This canvas did not compile" detail=\{record\.diagnostics \?\? '[^']+'\} action=\{showSourceAction\} \/>/)
})

test('a history rewind re-lists the canvases and closes the sheet when its canvas is gone', () => {
  assert.match(sheet, /if \(events\[index\]\.type === 'history_rewound'\) return events\[index\]\.seq/)
  assert.match(sheet, /const rewoundSeq = useAppStore\(state => lastRewindSeq\(state\.snapshots\[sessionId\]\?\.events \?\? EMPTY_EVENTS\)\)/)
  assert.match(sheet, /\.then\(list => list\.canvases\.some\(canvas => canvas\.name === name\)\)[\s\S]*?\.then\(present => \{ if \(present\) setReloadToken\(token => token \+ 1\); else onClose\(\) \}\)/)
})

test('markdown .canvas.tsx links open the sheet instead of Linking', () => {
  assert.match(markdown, /import \{ openCanvasLink \} from '\.\.\/lib\/canvas-links'/)
  assert.match(markdown, /const openLink = useCallback\(\(url: string\) => \{\n    if \(openCanvasLink\(url, sourceSessionId \?\? null\)\) return false\n    void Linking\.openURL\(url\)/)
  assert.match(links, /export const OPEN_CANVAS_EVENT = 'agentsdock:open-canvas'/)
  assert.match(links, /const name = canvasNameFromPath\(href\)\n  if \(!name\) return false\n  DeviceEventEmitter\.emit\(OPEN_CANVAS_EVENT, \{ sessionId, name \}/)
  assert.match(page, /if \(!clean\.endsWith\(CANVAS_SUFFIX\)\) return null/)
  assert.match(chatScreen, /DeviceEventEmitter\.addListener\(OPEN_CANVAS_EVENT, \(request: OpenCanvasRequest\) => \{\n\s+if \(request\.sessionId && request\.sessionId !== sessionId\) return\n\s+dismissAppKeyboard\(\)\n\s+setCanvasName\(request\.name\)/)
  assert.match(chatScreen, /\{!welcome \? <CanvasSheet sessionId=\{sessionId\} name=\{canvasName\} onClose=\{\(\) => setCanvasName\(null\)\} \/> : null\}/)
})

test('the sheet searches the rendered canvas by injecting a find script and rendering the count', () => {
  // The WebView needs a ref so the search field can inject JS into it.
  assert.match(sheet, /const webViewRef = useRef<WebView>\(null\)/)
  assert.match(sheet, /ref=\{webViewRef\}/)
  assert.match(sheet, /import \{ buildCanvasPage, canvasFindScript, parseCanvasPageMessage/)
  assert.match(sheet, /webViewRef\.current\?\.injectJavaScript\(canvasFindScript\(query, options\)\)/)
  // Typing injects the query; next/prev step the active match; the count comes back over onMessage.
  assert.match(sheet, /onChangeText=\{text => \{ setFindQuery\(text\); injectFind\(text\) \}\}/)
  assert.match(sheet, /injectFind\(findQuery, \{ findNext: true, forward: true \}\)/)
  assert.match(sheet, /injectFind\(findQuery, \{ findNext: true, forward: false \}\)/)
  assert.match(sheet, /case 'find-result':\s+setFindResult\(\{ total: message\.total, active: message\.active \}\)/)
  assert.match(sheet, /testID="canvas-find-count"[\s\S]*?\$\{findResult\.active\}\/\$\{findResult\.total\}/)
  // Closing clears the highlights, and a reload re-runs the open query once the page mounts.
  assert.match(sheet, /const closeFind = \(\) => \{[\s\S]*?injectFind\(''\)/)
  assert.match(sheet, /onLoadEnd=\{\(\) => \{ if \(findOpen && findQuery\) injectFind\(findQuery\) \}\}/)
  // The find script is a pure builder that highlights and reports back over the WebView channel.
  assert.match(page, /export function canvasFindScript\(query: string, options: \{ forward\?: boolean; matchCase\?: boolean; findNext\?: boolean \} = \{\}\): string/)
  assert.match(page, /CSS\.highlights\.set\('canvas-find'/)
  assert.match(page, /message: \{ kind: 'find-result', total: state\.ranges\.length/)
})

test('the Outputs panel lists the chat canvases as Canvas rows that open the sheet', () => {
  assert.match(panel, /client\.listCanvases\(sessionId\)\.then\(list => \{ if \(!stale\) setCanvases\(list\.canvases\) \}\)/)
  assert.match(panel, /\}, \[sessionId, visible\]\)/, 'canvases are listed when the panel opens')
  assert.match(panel, /case 'canvas':\n\s+return <Row key=\{`canvas:\$\{item\.path\}`\} icon=\{Frame\} label=\{item\.label\} secondary="Canvas" onPress=\{\(\) => closeThen\(\(\) => onOpenCanvas\(item\.name\)\)\} \/>/)
  assert.match(collector, /const outputs: ChatOutputItem\[\] = canvases\.map\(canvas => \(\{\n\s+kind: 'canvas', label: canvasLinkText\.get\(canvas\.name\) \?\? canvas\.name, name: canvas\.name, path: canvas\.path,/)
  assert.match(chatScreen, /onOpenCanvas=\{setCanvasName\}/)
})
