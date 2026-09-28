/**
 * Assembles the sandboxed page a Canvas renders in, mirroring
 * electron/src/main/canvas-protocol.ts: the server's shell.html with data: URL
 * scripts for a bridge shim, vendor.js, the compiled report and the mount call.
 * The shell's CSP (`script-src data:`, `connect-src 'none'`) keeps reports
 * offline; base64 keeps a `</script>` inside a report from ending its tag.
 * Pure: no React Native imports, so it runs under node for tests.
 */

export interface CanvasHostTheme {
  background: string
  foreground: string
  muted: string
  border: string
  accent: string
  kind: 'light' | 'dark'
}

export type CanvasPageMessage =
  | { kind: 'ready' }
  | { kind: 'state'; key: string; value: unknown }
  | { kind: 'error'; error: string }
  | { kind: 'link'; url: string }
  /** Injected in-page find reports its running match count back over the same channel. */
  | { kind: 'find-result'; total: number; active: number }
  /** Element feedback and agent actions exist on the desktop only; the sheet ignores them. */
  | { kind: 'action' | 'selection' }

/** `source` of the JSON envelopes the page posts through window.ReactNativeWebView. */
export const CANVAS_PAGE_MESSAGE_SOURCE = 'agentsdock-canvas'
/** A Canvas name is the stem of `<name>.canvas.tsx`; same rule as the server's NAME_RE. */
export const CANVAS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CANVAS_SUFFIX = '.canvas.tsx'
const SCRIPTS_PLACEHOLDER = '<!--CANVAS_SCRIPTS-->'

/** "…/report.canvas.tsx" (path, URL or file: link) -> "report"; null when it is not a Canvas path. */
export function canvasNameFromPath(value: string | null | undefined): string | null {
  if (!value) return null
  const clean = value.replace(/^file:\/\//, '').split(/[?#]/)[0]
  if (!clean.endsWith(CANVAS_SUFFIX)) return null
  let name: string
  try { name = decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1, -CANVAS_SUFFIX.length)) } catch { return null }
  return CANVAS_NAME_PATTERN.test(name) ? name : null
}

/**
 * Runs before vendor.js. The runtime posts to the WKWebView handler
 * `window.webkit.messageHandlers.zedCanvas`; this routes it to
 * react-native-webview's channel. On iOS that library keeps its own handler in
 * the same namespace, so zedCanvas is added beside it, never over it.
 */
const BRIDGE_SHIM = `
(() => {
  const PAGE = ${JSON.stringify(CANVAS_PAGE_MESSAGE_SOURCE)};
  const zedCanvas = { postMessage(raw) {
    let message = raw;
    try { message = JSON.parse(raw); } catch {}
    window.ReactNativeWebView.postMessage(JSON.stringify({ source: PAGE, message }));
  } };
  const webkit = window.webkit || (window.webkit = {});
  const handlers = webkit.messageHandlers || (webkit.messageHandlers = {});
  try { Object.defineProperty(handlers, 'zedCanvas', { value: zedCanvas, configurable: true }); }
  catch { webkit.messageHandlers = Object.assign(Object.create(handlers), { zedCanvas }); }
})();
`

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Hermes has no Buffer; TextEncoder gives the UTF-8 bytes a data: URL must carry.
function base64(source: string): string {
  const bytes = new TextEncoder().encode(source)
  const chunks: string[] = []
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]
    const second = index + 1 < bytes.length ? bytes[index + 1] : null
    const third = index + 2 < bytes.length ? bytes[index + 2] : null
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0)
    chunks.push(
      BASE64_ALPHABET[triple >> 18]
      + BASE64_ALPHABET[(triple >> 12) & 63]
      + (second === null ? '=' : BASE64_ALPHABET[(triple >> 6) & 63])
      + (third === null ? '=' : BASE64_ALPHABET[triple & 63]),
    )
  }
  return chunks.join('')
}

export function buildCanvasPage(input: {
  shell: string
  vendor: string
  javascript: string
  state: Record<string, unknown>
  theme: CanvasHostTheme
}): string {
  if (!input.shell.includes(SCRIPTS_PLACEHOLDER)) throw new Error('Canvas shell is missing its script placeholder.')
  const mount = `__zedCanvasHost.mount(${JSON.stringify(input.state)}, ${JSON.stringify(input.theme)});`
  const scripts = [BRIDGE_SHIM, input.vendor, input.javascript, mount]
    .map(source => `<script src="data:application/javascript;base64,${base64(source)}"></script>`)
    .join('')
  // Function form: a string replacement would expand `$&`-style patterns inside the scripts.
  return input.shell.replace(SCRIPTS_PLACEHOLDER, () => scripts)
}

/**
 * JS injected into the WebView to search the rendered canvas. react-native-webview
 * exposes no find UI, so this highlights matches with the CSS Custom Highlight API
 * (it decorates ranges without touching the DOM, so it never fights the runtime's
 * React tree) and posts the running count back over window.ReactNativeWebView. State
 * lives on window.__canvasFind so a follow-up `findNext` steps without re-collecting.
 * An empty query clears. Trailing `true;` keeps react-native-webview from warning.
 */
export function canvasFindScript(query: string, options: { forward?: boolean; matchCase?: boolean; findNext?: boolean } = {}): string {
  const request = JSON.stringify({ query, forward: options.forward ?? true, matchCase: !!options.matchCase, findNext: !!options.findNext })
  return `(() => {
  const PAGE = ${JSON.stringify(CANVAS_PAGE_MESSAGE_SOURCE)};
  const request = ${request};
  const state = window.__canvasFind || (window.__canvasFind = { ranges: [], at: -1 });
  const ok = () => window.CSS && CSS.highlights && document.body;
  const post = () => window.ReactNativeWebView.postMessage(JSON.stringify({ source: PAGE, message: { kind: 'find-result', total: state.ranges.length, active: state.ranges.length ? state.at + 1 : 0 } }));
  const clear = () => { state.ranges = []; state.at = -1; if (window.CSS && CSS.highlights) { CSS.highlights.delete('canvas-find'); CSS.highlights.delete('canvas-find-active'); } };
  const style = () => { if (!ok() || window.__canvasFindStyled) return; try { const sheet = new CSSStyleSheet(); sheet.replaceSync('::highlight(canvas-find){background:rgba(250,204,21,.45);color:inherit}::highlight(canvas-find-active){background:#f97316;color:#14181f}'); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; window.__canvasFindStyled = true; } catch (error) {} };
  const collect = (raw) => { const out = []; const needle = request.matchCase ? raw : raw.toLowerCase(); const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, node => node.nodeValue && node.nodeValue.trim() && !(node.parentElement && node.parentElement.closest('script,style,noscript')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT); for (let node; (node = walker.nextNode());) { const hay = request.matchCase ? node.nodeValue : node.nodeValue.toLowerCase(); for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) { const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + raw.length); out.push(range); } } return out; };
  const paint = () => { if (!ok()) return; if (state.at < 0) { CSS.highlights.delete('canvas-find-active'); return; } CSS.highlights.set('canvas-find-active', new Highlight(state.ranges[state.at])); const anchor = state.ranges[state.at].startContainer.parentElement; if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ block: 'center', inline: 'nearest' }); };
  if (!request.query || !ok()) { clear(); post(); return; }
  if (request.findNext && state.ranges.length) { state.at = (state.at + (request.forward ? 1 : -1) + state.ranges.length) % state.ranges.length; }
  else { style(); state.ranges = collect(request.query); state.at = state.ranges.length ? 0 : -1; CSS.highlights.set('canvas-find', new Highlight(...state.ranges)); }
  paint(); post();
})(); true;`
}

/** Decodes one WebView `onMessage` payload; null for anything the bridge shim did not send. */
export function parseCanvasPageMessage(data: string): CanvasPageMessage | null {
  let envelope: unknown
  try { envelope = JSON.parse(data) } catch { return null }
  if (!envelope || typeof envelope !== 'object') return null
  const { source, message } = envelope as { source?: unknown; message?: unknown }
  if (source !== CANVAS_PAGE_MESSAGE_SOURCE || !message || typeof message !== 'object') return null
  return typeof (message as { kind?: unknown }).kind === 'string' ? message as CanvasPageMessage : null
}
