import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'scripts/pdf-viewer-entry.ts')
const target = resolve(root, 'src/editor/pdfViewerAssets.ts')
const pdfjsRoot = resolve(root, 'node_modules/pdfjs-dist')
const check = process.argv.includes('--check')

const { version } = JSON.parse(await readFile(resolve(pdfjsRoot, 'package.json'), 'utf8'))
const buildResult = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  // The legacy pdf.js build polyfills what older Android System WebViews lack.
  target: ['chrome100'],
  minify: true,
  charset: 'utf8',
  legalComments: 'eof',
  sourcemap: false,
  logLevel: 'silent',
})
const bundle = buildResult.outputFiles[0]?.text
if (!bundle) throw new Error('The pdf.js viewer bundle produced no output.')

// Everything pdf.js would fetch, embedded so the page stays offline:
// - every predefined CMap: CJK text in fonts the PDF does not embed;
// - Symbol and ZapfDingbats: the only standard fonts pdf.js will not replace
//   with a system font (the page keeps useSystemFonts on);
// - the JBIG2 and JPEG 2000 decoders scanned documents use. Their no-wasm
//   fallbacks load through dynamic import(), which this page cannot serve.
// qcms (ICC colour) is not listed: pdf.js loads it only with worker fetch.
const cmapNames = (await readdir(resolve(pdfjsRoot, 'cmaps'))).filter(name => name.endsWith('.bcmap')).sort()
const assetFiles = {
  cMapUrl: cmapNames.map(name => ['cmaps', name]),
  standardFontDataUrl: [['standard_fonts', 'FoxitSymbol.pfb'], ['standard_fonts', 'FoxitDingbats.pfb']],
  wasmUrl: [['wasm', 'jbig2.wasm'], ['wasm', 'openjpeg.wasm']],
}
const assets = {}
for (const [kind, files] of Object.entries(assetFiles)) {
  assets[kind] = {}
  for (const [directory, name] of files) assets[kind][name] = (await readFile(resolve(pdfjsRoot, directory, name))).toString('base64')
}

const script = `var PDF_ASSETS=${JSON.stringify(assets)};${bundle}`.replace(/<\/script/gi, '<\\/script')
const scriptHash = createHash('sha256').update(script).digest()
const csp = [
  "default-src 'none'",
  // wasm-unsafe-eval compiles the embedded image decoders; string eval stays blocked.
  `script-src 'sha256-${scriptHash.toString('base64')}' 'wasm-unsafe-eval'`,
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  // pdf.js turns decoded images and embedded fonts into blob:/data: URLs.
  "img-src blob: data:",
  "font-src blob: data:",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')
// The text layer rules are a flattened copy of pdf.js's web/pdf_viewer.css
// .textLayer block, which uses CSS nesting that older WebViews drop whole.
const appStyle = [
  'html,body{margin:0;padding:0;background:#1d1f24;-webkit-text-size-adjust:100%}',
  '*{box-sizing:border-box}',
  '#pages{display:flex;flex-direction:column;gap:var(--page-gap);padding:var(--page-gap) 0}',
  '.page{position:relative;width:100%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35)}',
  '.page canvas{position:absolute;inset:0;width:100%;height:100%;display:block}',
  '.textLayer{position:absolute;text-align:initial;inset:0;overflow:clip;opacity:1;line-height:1;letter-spacing:normal;word-spacing:normal;-webkit-text-size-adjust:none;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;z-index:0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}',
  '.textLayer span,.textLayer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;-webkit-user-select:text;user-select:text}',
  '.textLayer>:not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}',
  '.textLayer .markedContent{display:contents}',
  '.textLayer span[role=img]{-webkit-user-select:none;user-select:none;cursor:default}',
  '.textLayer ::selection{background:rgba(0,0,255,.25);color:transparent}',
  '.textLayer br::selection{background:transparent}',
  '.textLayer .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;-webkit-user-select:none;user-select:none}',
  '.textLayer.selecting .endOfContent{top:0}',
].join('')
const htmlPrefix = [
  '<!doctype html>',
  '<html>',
  '<head>',
  '<meta charset="utf-8">',
  // Pinch zoom is the WebView's own; the page re-renders sharp once it settles.
  '<meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=6,user-scalable=yes">',
  `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
  `<style>${appStyle}</style>`,
  '</head>',
  '<body>',
  '<div id="pages"></div>',
  '<script>',
].join('')
const htmlSuffix = '</script></body></html>'
const generated = [
  '// Generated by scripts/embed-pdf-viewer.mjs. Do not edit by hand.',
  `export const PDF_VIEWER_PDFJS_VERSION = ${JSON.stringify(version)}`,
  `export const PDF_VIEWER_ASSET_SHA256 = ${JSON.stringify(scriptHash.toString('hex'))}`,
  // One literal: Metro constant-folds a SCRIPT + HTML form and stores the
  // program twice in Hermes bytecode.
  `export const PDF_VIEWER_HTML = ${JSON.stringify(`${htmlPrefix}${script}${htmlSuffix}`)}`,
  '',
].join('\n')

const existing = await readFile(target, 'utf8').catch(() => null)
if (check) {
  if (existing !== generated) {
    console.error('Generated PDF viewer assets are stale. Run: node scripts/embed-pdf-viewer.mjs')
    process.exitCode = 1
  }
} else if (existing !== generated) {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, generated)
}
