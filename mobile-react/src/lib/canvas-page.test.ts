import assert from 'node:assert/strict'
import { CANVAS_PAGE_MESSAGE_SOURCE, COMMENT_PINS_SCRIPT, buildCanvasPage, canvasCommentPinsScript, canvasFindScript, canvasFocusCommentScript, canvasNameFromPath, canvasSelectingScript, parseCanvasPageMessage, type CanvasHostTheme } from './canvas-page'

const shell = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src data:"></head><body><div id="root"></div><!--CANVAS_SCRIPTS--></body></html>'
const theme: CanvasHostTheme = { background: '#282c33', foreground: '#dce0e5', muted: '#a9afbc', border: '#464b57', accent: '#74ade8', kind: 'dark' }

function decodedScripts(html: string): string[] {
  return [...html.matchAll(/<script src="data:application\/javascript;base64,([A-Za-z0-9+/=]*)"><\/script>/g)]
    .map(match => Buffer.from(match[1], 'base64').toString('utf8'))
}

// --- script order, escaping, state and theme injection
{
  const javascript = 'const report = "</script><script>alert(1)</script> — é 🎯";'
  const html = buildCanvasPage({ shell, vendor: 'window.vendor = true;', javascript, state: { filter: 'open' }, theme })
  const scripts = decodedScripts(html)
  assert.equal(scripts.length, 4, 'shim, vendor, report and mount, in that order')
  assert.match(scripts[0], /const PAGE = "agentsdock-canvas";/)
  assert.match(scripts[0], /window\.ReactNativeWebView\.postMessage\(JSON\.stringify\(\{ source: PAGE, message \}\)\)/, 'the shim posts to the WebView channel')
  assert.match(scripts[0], /Object\.defineProperty\(handlers, 'zedCanvas'/, 'the runtime finds its zedCanvas handler')
  assert.match(scripts[0], /window\.webkit \|\| \(window\.webkit = \{\}\)/, 'react-native-webview\'s own iOS handler survives')
  assert.doesNotMatch(scripts[0], /window\.parent\.postMessage/, 'the desktop iframe channel is not kept')
  assert.equal(scripts[1], 'window.vendor = true;')
  assert.equal(scripts[2], javascript, 'the report survives the base64 round-trip with multi-byte characters')
  assert.equal(scripts[3], `__zedCanvasHost.mount({"filter":"open"}, ${JSON.stringify(theme)});`)
  assert.equal((html.match(/<script/g) ?? []).length, 4, 'a </script> inside the report cannot open a fifth tag')
  assert.ok(!html.includes('<!--CANVAS_SCRIPTS-->'), 'the placeholder is consumed')
  assert.ok(html.startsWith('<!doctype html>') && html.includes('Content-Security-Policy'), 'the shell and its CSP frame the scripts')
  assert.ok(html.indexOf('<div id="root"></div>') < html.indexOf('<script'), 'scripts follow the root element')
}

// --- an empty state still mounts, and the shell must carry the placeholder
{
  const scripts = decodedScripts(buildCanvasPage({ shell, vendor: '', javascript: '', state: {}, theme: { ...theme, kind: 'light' } }))
  assert.equal(scripts[3], `__zedCanvasHost.mount({}, ${JSON.stringify({ ...theme, kind: 'light' })});`)
  assert.throws(() => buildCanvasPage({ shell: '<html></html>', vendor: '', javascript: '', state: {}, theme }), /placeholder/)
}

// --- canvasNameFromPath
assert.equal(canvasNameFromPath('canvases/budget.canvas.tsx'), 'budget')
assert.equal(canvasNameFromPath('file:///w/canvases/q3-report.canvas.tsx?x=1#y'), 'q3-report')
assert.equal(canvasNameFromPath('/w/canvases/q3%2Dreport.canvas.tsx'), 'q3-report', 'percent-encoded stems decode')
assert.equal(canvasNameFromPath('notes/report.tsx'), null)
assert.equal(canvasNameFromPath('canvases/.hidden.canvas.tsx'), null, 'names follow the server pattern')
assert.equal(canvasNameFromPath('canvases/%E0%A4%A.canvas.tsx'), null, 'a malformed escape is not a canvas')
assert.equal(canvasNameFromPath(null), null)

// --- parseCanvasPageMessage
assert.deepEqual(
  parseCanvasPageMessage(JSON.stringify({ source: CANVAS_PAGE_MESSAGE_SOURCE, message: { kind: 'state', key: 'filter', value: 1 } })),
  { kind: 'state', key: 'filter', value: 1 },
)
assert.equal(parseCanvasPageMessage(JSON.stringify({ source: 'other', message: { kind: 'ready' } })), null)
assert.equal(parseCanvasPageMessage(JSON.stringify({ source: CANVAS_PAGE_MESSAGE_SOURCE, message: 'ready' })), null)
assert.equal(parseCanvasPageMessage('not json'), null)

// --- canvasFindScript: carries the query, highlights and reports the count over the WebView channel
{
  const script = canvasFindScript('needle', { findNext: true, forward: false })
  assert.match(script, /const request = \{"query":"needle","forward":false,"matchCase":false,"findNext":true\};/)
  assert.match(script, /CSS\.highlights\.set\('canvas-find'/, 'matches are painted with the Custom Highlight API')
  assert.match(script, /window\.ReactNativeWebView\.postMessage\(JSON\.stringify\(\{ source: PAGE, message: \{ kind: 'find-result', total: state\.ranges\.length, active/)
  assert.match(script, /window\.__canvasFind /, 'find state persists across injections so findNext steps in place')
  assert.ok(script.trimEnd().endsWith('true;'), 'react-native-webview wants a trailing expression')
  // The parser accepts the find-result envelope the script posts back.
  assert.deepEqual(
    parseCanvasPageMessage(JSON.stringify({ source: CANVAS_PAGE_MESSAGE_SOURCE, message: { kind: 'find-result', total: 12, active: 3 } })),
    { kind: 'find-result', total: 12, active: 3 },
  )
}
// An empty query clears rather than collecting.
assert.match(canvasFindScript(''), /if \(!request\.query \|\| !ok\(\)\) \{ clear\(\); post\(\); return; \}/)

// --- comments: the shim installs the pins, and the injected calls are plain JS for the WebView
{
  const page = buildCanvasPage({ shell: '<body><!--CANVAS_SCRIPTS--></body>', vendor: '', javascript: '', state: {}, theme: { background: '#000', foreground: '#fff', muted: '#888', border: '#333', accent: '#4af', kind: 'dark' } })
  const shim = new TextDecoder().decode(Uint8Array.from(atob(page.match(/base64,([^"]+)/)![1]), character => character.charCodeAt(0)))
  assert.ok(shim.includes(COMMENT_PINS_SCRIPT), 'the bridge shim installs window.__agentsdockComments')
  assert.match(COMMENT_PINS_SCRIPT, /post\(\{ kind: 'comment-open', id: pin\.id \}\)/)
  // Every injected script must parse; a syntax error is silent inside the WebView.
  for (const script of [
    shim,
    canvasSelectingScript(true),
    canvasSelectingScript(false),
    canvasCommentPinsScript([{ id: 'cmt_1', number: 1, canvasId: 'a"b', tag: 'td', text: '</script> x' }], 'cmt_1'),
    canvasFocusCommentScript('cmt_1'),
  ]) {
    assert.doesNotThrow(() => new Function(script), script.slice(0, 80))
  }
  assert.match(canvasSelectingScript(false), /host\.setSelecting\(false\); host\.clearSelection\(\);/)
  assert.deepEqual(
    parseCanvasPageMessage(JSON.stringify({ source: CANVAS_PAGE_MESSAGE_SOURCE, message: { kind: 'comment-anchors', located: ['cmt_1'] } })),
    { kind: 'comment-anchors', located: ['cmt_1'] },
  )
}

console.log('canvas page tests passed')
