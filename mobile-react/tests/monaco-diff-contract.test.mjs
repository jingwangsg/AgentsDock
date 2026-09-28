import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const review = source('src/components/CodeReview.tsx')
const view = source('src/components/MonacoDiffView.tsx')
const preference = source('src/lib/review-layout-preference.ts')
const entry = source('scripts/monaco-diff-entry.ts')
const assets = source('src/editor/monacoDiffAssets.ts')
const packageJson = JSON.parse(source('package.json'))
const installed = JSON.parse(source('node_modules/monaco-editor/package.json'))
const exported = name => JSON.parse(new RegExp(`^export const ${name} = (.*)$`, 'm').exec(assets)[1])
const html = exported('MONACO_DIFF_HTML')

test('the review pane renders the selected file with the Monaco diff editor and keeps no native line renderer', () => {
  assert.match(review, /import \{ MonacoDiffView \} from '\.\/MonacoDiffView'/)
  assert.match(review, /<MonacoDiffView file=\{file\} path=\{file\.path\} sideBySide=\{sideBySide\} wordWrap=\{layout\.wordWrap\} gapLabel=\{gapLabel\} \/>/)
  // A module-scope label keeps the model memo stable across renders.
  assert.match(review, /^const gapLabel = \(unchanged: number \| null\) => /m)
  assert.doesNotMatch(review, /ReviewLine|DiffLine|conflictMarkerLabel|conflictMarkerAccessibleName|lineNumber:/)
  assert.doesNotMatch(review, /<ScrollView style=\{styles\.diff\}/)
})

test('the header toggles layout and wrapping and persists both choices', () => {
  assert.match(review, /import \{ readReviewLayout, writeReviewLayout, type ReviewLayoutPreference \} from '\.\.\/lib\/review-layout-preference'/)
  assert.match(review, /<IconButton icon=\{sideBySide \? Columns2 : Rows3\} onPress=\{\(\) => chooseLayout\(!sideBySide\)\}[^\n]*testID="review-layout-toggle" \/>/)
  assert.match(review, /<IconButton icon=\{WrapText\} selected=\{layout\.wordWrap\} onPress=\{toggleWordWrap\} label="Wrap long lines" testID="review-word-wrap" \/>/)
  assert.match(review, /void writeReviewLayout\(\{ sideBySide: value \}\)/)
  assert.match(review, /void writeReviewLayout\(\{ wordWrap \}\)/)
  // A stored layout wins; otherwise the workspace width decides, so phones in portrait start inline.
  assert.match(review, /const sideBySide = layout\.sideBySide \?\? workspaceWidth >= SIDE_BY_SIDE_MIN_WIDTH/)
  assert.match(review, /<View style=\{styles\.workspace\} onLayout=\{event => setWorkspaceWidth\(event\.nativeEvent\.layout\.width\)\}>/)
  assert.match(preference, /import AsyncStorage from '@react-native-async-storage\/async-storage'/)
  assert.match(preference, /REVIEW_SIDE_BY_SIDE_STORAGE_KEY = 'agentsdock\.reviewSideBySide'/)
  assert.match(preference, /REVIEW_WORD_WRAP_STORAGE_KEY = 'agentsdock\.reviewWordWrap'/)
})

test('the diff view hosts the page in a locked-down WebView that owns its own scrolling', () => {
  assert.match(view, /import WebView, \{ type WebViewMessageEvent \} from 'react-native-webview'/)
  assert.match(view, /import \{ MONACO_DIFF_HTML \} from '\.\.\/editor\/monacoDiffAssets'/)
  assert.match(view, /const MONACO_DIFF_SOURCE = \{ html: MONACO_DIFF_HTML, baseUrl: MONACO_DIFF_BASE_URL \}/)
  assert.match(view, /originWhitelist=\{\['about:blank', 'https:\/\/agentsdock\.local'\]\}/)
  assert.match(view, /onShouldStartLoadWithRequest=\{navigation => navigation\.url === 'about:blank' \|\| navigation\.url\.startsWith\(MONACO_DIFF_BASE_URL\)\}/)
  assert.match(view, /scrollEnabled=\{false\}/)
  assert.match(view, /bounces=\{false\}/)
  assert.match(view, /onContentProcessDidTerminate=\{\(\) => setError\(/)
  assert.match(view, /<Loading label="Loading diff editor" \/>/)
  assert.match(view, /The diff editor could not render this file — \{error\}/)
  // Monaco is the only route: no ScrollView-based fallback renderer.
  assert.doesNotMatch(view, /ScrollView|CodeMirror|codemirror/)
})

test('the host protocol loads per file with the current options and restyles through options messages', () => {
  assert.match(view, /const model = useMemo\(\(\) => buildMonacoDiffModel\(file, gapLabel\), \[file, gapLabel\]\)/)
  assert.match(view, /postMessage\(JSON\.stringify\(\{ type: 'load', path, \.\.\.model, \.\.\.optionsRef\.current, fontSize: FONT_SIZE \}\)\)/)
  assert.match(view, /\}, \[ready, model, path\]\)/)
  assert.match(view, /postMessage\(JSON\.stringify\(\{ type: 'options', sideBySide, wordWrap, theme \}\)\)/)
  assert.match(view, /\}, \[ready, sideBySide, wordWrap, theme\]\)/)
  assert.match(view, /if \(message\.type === 'ready'\) setReady\(true\)/)
  assert.match(view, /else if \(message\.type === 'error'\) setError\(/)
  assert.match(entry, /if \(message\.type === 'load'\) load\(message\)/)
  assert.match(entry, /else if \(message\.type === 'options' && editor\)/)
  assert.match(entry, /post\(\{ type: 'ready' \}\)/)
  assert.match(entry, /post\(\{ type: 'error', message: describe\(error\) \}\)/)
  assert.match(entry, /window\.addEventListener\('message', receive\)\n\s*document\.addEventListener\('message', receive as EventListener\)/)
})

test('the page keeps one diff editor, swaps models per load, and runs Monaco without a web worker', () => {
  assert.match(entry, /import \* as monaco from 'monaco-editor\/editor\/editor\.api'/)
  assert.match(entry, /import 'monaco-editor\/basic-languages\/monaco\.contribution'/)
  assert.match(entry, /import \{ languageIdForPath, type MonacoDiffModel \} from '\.\.\/src\/lib\/monaco-diff-model'/)
  // Throwing from getWorker makes EditorWorkerClient fall back synchronously to its in-process worker.
  assert.match(entry, /window\.MonacoEnvironment = \{\n\s*getWorker: \(\) => \{ throw new Error\(/)
  assert.match(entry, /editor = monaco\.editor\.createDiffEditor\(host, \{/)
  for (const option of ['readOnly: true,', 'domReadOnly: true,', 'automaticLayout: true,', 'minimap: { enabled: false },', 'ignoreTrimWhitespace: false,']) assert.ok(entry.includes(option), option)
  assert.match(entry, /editor\.setModel\(null\)\n\s*models\?\.original\.dispose\(\)\n\s*models\?\.modified\.dispose\(\)/)
  assert.match(entry, /editor\.updateOptions\(\{ renderSideBySide: message\.sideBySide, diffWordWrap: message\.wordWrap \? 'on' : 'off', fontSize: message\.fontSize \}\)/)
  assert.match(entry, /lineNumbers: line => String\(numbers\[line - 1\] \?\? ''\)/)
  assert.match(entry, /className: 'review-monaco-gap', inlineClassName: 'review-monaco-gap-text'/)
  assert.match(entry, /className: `review-monaco-conflict \$\{conflict\.side\}`/)
  // The editor lives as long as the page; nothing ever calls into a disposed instance.
  assert.doesNotMatch(entry, /editor\.dispose\(\)/)
})

test('the embedded page carries Monaco inline under a hash-pinned CSP with no network, font, or worker access', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.equal(scripts.length, 1, 'one inline script: Monaco and its host protocol')
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/)
  const hash = createHash('sha256').update(scripts[0][1]).digest()
  assert.equal(exported('MONACO_DIFF_ASSET_SHA256'), hash.toString('hex'))
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)[1]
  assert.match(csp, new RegExp(`script-src 'sha256-${hash.toString('base64').replace(/[+/=]/g, '\\$&')}'`))
  for (const directive of ["default-src 'none'", "connect-src 'none'", "worker-src 'none'", "font-src 'none'", "style-src 'unsafe-inline'"]) assert.match(csp, new RegExp(directive.replace(/[-'()]/g, '\\$&')))
  // Every stylesheet is inline and self-contained: no url() left that could point at a file.
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1])
  assert.equal(styles.length, 2, 'Monaco CSS plus the review decoration CSS')
  for (const style of styles) assert.doesNotMatch(style, /url\(|@font-face/)
  for (const marker of ['createDiffEditor', 'agentsdock-dark', 'agentsdock-light', 'review-monaco-gap', 'review-monaco-conflict', 'monaco-diff-editor', 'Web workers are unavailable inside the review WebView']) assert.ok(html.includes(marker), marker)
})

test('the generated asset tracks the installed monaco-editor and regenerates on install', () => {
  assert.equal(exported('MONACO_DIFF_VERSION'), installed.version)
  assert.ok(packageJson.devDependencies['monaco-editor'], 'monaco-editor is a dev dependency: only its bundle ships, inside the WebView page')
  assert.equal(packageJson.dependencies['monaco-editor'], undefined)
  assert.equal(packageJson.scripts['embed:monaco-diff'], 'node scripts/embed-monaco-diff.mjs')
  assert.match(packageJson.scripts.postinstall, /node scripts\/embed-monaco-diff\.mjs/)
  execFileSync(process.execPath, ['scripts/embed-monaco-diff.mjs', '--check'], { stdio: 'pipe' })
  // React Native code never imports monaco-editor; the page bundle is its only consumer.
  const files = fs.readdirSync('src', { recursive: true }).filter(file => /\.tsx?$/.test(file))
  for (const file of files) assert.doesNotMatch(source(path.join('src', file)), /from 'monaco-editor/, file)
})
