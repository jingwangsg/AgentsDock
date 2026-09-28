import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const markdown = await readFile(resolve('src/components/MarkdownContent.tsx'), 'utf8')
const diagram = await readFile(resolve('src/components/MermaidDiagram.tsx'), 'utf8')
const assets = await readFile(resolve('src/components/mermaidAssets.ts'), 'utf8')
const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
const installed = JSON.parse(await readFile(resolve('node_modules/mermaid/package.json'), 'utf8'))
const exported = name => JSON.parse(new RegExp(`^export const ${name} = (".*")$`, 'm').exec(assets)[1])
const html = exported('MERMAID_HTML')

test('mermaid fences leave the plain fence renderer for the WebView diagram, source kept as the fallback', () => {
  assert.match(markdown, /import \{ MermaidDiagram \} from '\.\/MermaidDiagram'/)
  assert.match(markdown, /fence: \(node, _children, _parents, styles, inheritedStyles\) => \{/)
  assert.match(markdown, /sourceInfo\?\.trim\(\)\.split\(\/\\s\+\/\)\[0\]/)
  assert.match(markdown, /language === 'mermaid' \? <MermaidDiagram key=\{node\.key\} source=\{code\}>\{block\}<\/MermaidDiagram> : block/)
})

test('the diagram WebView is offline, sandboxed, idle-debounced, and never blank', () => {
  assert.match(diagram, /import WebView, \{ type WebViewMessageEvent \} from 'react-native-webview'/)
  assert.match(diagram, /const MERMAID_SOURCE = \{ html: MERMAID_HTML, baseUrl: MERMAID_BASE_URL \}/)
  assert.match(diagram, /source=\{MERMAID_SOURCE\}/)
  assert.match(diagram, /originWhitelist=\{\['about:blank', 'https:\/\/agentsdock\.local'\]\}/)
  assert.match(diagram, /allowFileAccess=\{false\}/)
  assert.match(diagram, /allowUniversalAccessFromFileURLs=\{false\}/)
  assert.match(diagram, /onShouldStartLoadWithRequest=\{navigation => navigation\.url === 'about:blank' \|\| navigation\.url\.startsWith\(MERMAID_BASE_URL\)\}/)
  assert.match(diagram, /const RENDER_IDLE_MS = 400/)
  assert.match(diagram, /setTimeout\(\(\) => \{ if \(readyRef\.current\) webViewRef\.current\?\.postMessage\(request\) \}, RENDER_IDLE_MS\)/)
  assert.match(diagram, /\{state\.status !== 'rendered' \? children : null\}/)
  assert.match(diagram, /Mermaid could not render this diagram — \{state\.message\}/)
  assert.match(diagram, /theme = useAppColorScheme\(\) === 'light' \? 'default' : 'dark'/)
})

test('the embedded page carries mermaid inline under a hash-pinned CSP with no network access', () => {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  assert.equal(scripts.length, 1, 'one inline script: the library and its host protocol')
  assert.doesNotMatch(html, /<script[^>]+src=/)
  const hash = createHash('sha256').update(scripts[0][1]).digest()
  assert.equal(exported('MERMAID_ASSET_SHA256'), hash.toString('hex'))
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)[1]
  assert.match(csp, new RegExp(`script-src 'sha256-${hash.toString('base64').replace(/[+/=]/g, '\\$&')}'`))
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /connect-src 'none'/)
  assert.match(csp, /style-src 'unsafe-inline'/)
  assert.match(scripts[0][1], /globalThis\["mermaid"\] = /)
  assert.match(scripts[0][1], /securityLevel: 'strict', suppressErrorRendering: true, theme: request\.theme/)
  assert.match(scripts[0][1], /document\.addEventListener\('message', receive\)/)
  assert.match(scripts[0][1], /post\(\{ type: 'ready' \}\)/)
})

test('the generated asset tracks the installed mermaid and regenerates on install', () => {
  assert.equal(exported('MERMAID_VERSION'), installed.version)
  assert.ok(packageJson.devDependencies.mermaid, 'mermaid is a dev dependency: only its bundle ships, inside the WebView page')
  assert.match(packageJson.scripts.postinstall, /node scripts\/embed-mermaid\.mjs/)
  execFileSync(process.execPath, ['scripts/embed-mermaid.mjs', '--check'], { stdio: 'pipe' })
})
