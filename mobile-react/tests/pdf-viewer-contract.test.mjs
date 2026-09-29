import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const source = relativePath => fs.readFileSync(path.resolve(relativePath), 'utf8')
const view = source('src/components/file-viewer/PdfDocumentView.tsx')
const entry = source('scripts/pdf-viewer-entry.ts')
const assets = source('src/editor/pdfViewerAssets.ts')
const packageJson = JSON.parse(source('package.json'))
const exported = name => JSON.parse(new RegExp(`^export const ${name} = (.*)$`, 'm').exec(assets)[1])
const html = exported('PDF_VIEWER_HTML')
const script = /<script>([\s\S]*)<\/script><\/body><\/html>$/.exec(html)[1]

test('the generated page is current and built from the pinned pdf.js', () => {
  execFileSync(process.execPath, ['scripts/embed-pdf-viewer.mjs', '--check'], { stdio: 'pipe' })
  assert.equal(exported('PDF_VIEWER_PDFJS_VERSION'), packageJson.devDependencies['pdfjs-dist'])
  assert.match(packageJson.scripts.postinstall, /node scripts\/embed-pdf-viewer\.mjs/)
})

test('the page is offline: hashed script, compiled wasm only, no network, no workers', () => {
  const hash = createHash('sha256').update(script).digest()
  assert.equal(exported('PDF_VIEWER_ASSET_SHA256'), hash.toString('hex'))
  assert.ok(html.includes(`script-src 'sha256-${hash.toString('base64')}' 'wasm-unsafe-eval'`))
  assert.ok(html.includes("connect-src 'none'"))
  assert.ok(html.includes("worker-src 'none'"))
  assert.doesNotMatch(html, /unsafe-eval'(?!.*wasm)/)
})

test('everything pdf.js fetches for CJK, symbol fonts and scanned images is embedded', () => {
  const embedded = JSON.parse(/^var PDF_ASSETS=(\{.*?\});/.exec(script)[1])
  assert.ok(embedded.cMapUrl['UniGB-UCS2-H.bcmap'], 'predefined CJK CMaps')
  assert.ok(embedded.cMapUrl['Adobe-GB1-UCS2.bcmap'])
  assert.equal(Object.keys(embedded.cMapUrl).length, fs.readdirSync('node_modules/pdfjs-dist/cmaps').filter(name => name.endsWith('.bcmap')).length)
  assert.deepEqual(Object.keys(embedded.standardFontDataUrl).sort(), ['FoxitDingbats.pfb', 'FoxitSymbol.pfb'])
  assert.deepEqual(Object.keys(embedded.wasmUrl).sort(), ['jbig2.wasm', 'openjpeg.wasm'])
  assert.match(entry, /BinaryDataFactory: EmbeddedBinaryDataFactory/)
  assert.match(entry, /isEvalSupported: false/)
  assert.match(entry, /\(globalThis as \{ pdfjsWorker\?: unknown \}\)\.pdfjsWorker = pdfjsWorker/)
})

test('the host streams the downloaded file in base64 chunks that decode independently', () => {
  const chunk = eval(/const CHUNK_BYTES = ([^\n]+)/.exec(view)[1])
  assert.equal(chunk % 3, 0)
  assert.match(view, /encoding: FileSystem\.EncodingType\.Base64,\n\s*position: offset,/)
  assert.match(view, /post\(\{ type: 'begin', size: info\.size, background: backgroundRef\.current \}\)/)
  assert.match(view, /post\(\{ type: 'chunk', offset, data \}\)/)
  assert.match(view, /post\(\{ type: 'end' \}\)/)
  assert.match(entry, /buffer\.set\(bytes, message\.offset\)/)
  assert.match(entry, /if \(received !== buffer\.length\) throw/)
})

test('the WebView is locked down and keeps the text layer on the glyphs', () => {
  assert.match(view, /const PDF_VIEWER_SOURCE = \{ html: PDF_VIEWER_HTML, baseUrl: PDF_VIEWER_BASE_URL \}/)
  assert.match(view, /allowFileAccess=\{false\}/)
  assert.match(view, /onShouldStartLoadWithRequest=\{navigation => navigation\.url === 'about:blank' \|\| navigation\.url\.startsWith\(PDF_VIEWER_BASE_URL\)\}/)
  assert.match(view, /textZoom=\{100\}/)
  assert.match(html, /maximum-scale=6,user-scalable=yes/)
})
