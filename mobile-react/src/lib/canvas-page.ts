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

/** One element the runtime's selection mode picked (tap in the WebView). */
export interface CanvasSelectedElement {
  id: string | null
  tag: string
  text: string
  html: string
}

/** A numbered marker the page draws on the element an open comment thread is about. */
export interface CanvasCommentPin {
  id: string
  number: number
  canvasId: string | null
  tag: string
  text: string
  label?: string
}

export type CanvasPageMessage =
  | { kind: 'ready' }
  | { kind: 'state'; key: string; value: unknown }
  | { kind: 'error'; error: string }
  | { kind: 'link'; url: string }
  /** Injected in-page find reports its running match count back over the same channel. */
  | { kind: 'find-result'; total: number; active: number }
  | { kind: 'selection'; elements: CanvasSelectedElement[]; complete: boolean }
  /** From the comment pins: a pin was tapped / which threads have their element in this revision. */
  | { kind: 'comment-open'; id: string }
  | { kind: 'comment-anchors'; located: string[] }
  /** Agent actions exist on the desktop only; the sheet ignores them. */
  | { kind: 'action' }

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
 * Comment pins, installed as window.__agentsdockComments: a numbered marker on the
 * element each open thread is about, in a layer outside #root so React never sees
 * it, re-placed whenever the report's layout changes. An anchor is found by
 * data-canvas-id, then by tag and leading text; threads whose element is gone from
 * this revision get no pin and are reported as not located.
 * Mirrors electron/src/main/canvas-protocol.ts COMMENT_PINS_SCRIPT.
 */
export const COMMENT_PINS_SCRIPT = `
  window.__agentsdockComments = (() => {
    const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
    let pins = [], active = null, layer = null, frame = 0, reported = '';
    const locate = pin => {
      const scope = pin.canvasId ? document.querySelector('[data-canvas-id="' + CSS.escape(pin.canvasId) + '"]') : null;
      const want = norm(pin.text).slice(0, 120);
      if (scope && scope.tagName.toLowerCase() === pin.tag && (!want || norm(scope.textContent).startsWith(want))) return scope;
      const root = scope || document.getElementById('root');
      if (root && want) for (const element of root.querySelectorAll(pin.tag)) if (norm(element.textContent).startsWith(want)) return element;
      return scope;
    };
    const place = () => {
      frame = 0;
      if (!layer) {
        const style = document.createElement('style');
        style.textContent = '#agentsdock-comment-pins{position:absolute;left:0;top:0;z-index:2147483646}'
          + '#agentsdock-comment-pins button{position:absolute;min-width:26px;height:26px;margin:0;padding:0 7px;border:2px solid var(--canvas-background);border-radius:13px 13px 13px 2px;background:var(--canvas-accent);color:var(--canvas-background);font:700 12px/20px -apple-system,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.35)}'
          + '#agentsdock-comment-pins button.active{transform:scale(1.2)}'
          + '[data-agentsdock-comment]{outline:2px dashed var(--canvas-accent)!important;outline-offset:3px}';
        document.head.appendChild(style);
        layer = document.createElement('div');
        layer.id = 'agentsdock-comment-pins';
        document.body.appendChild(layer);
        const root = document.getElementById('root') || document.body;
        new ResizeObserver(schedule).observe(document.body);
        new MutationObserver(schedule).observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
        window.addEventListener('resize', schedule);
      }
      for (const element of document.querySelectorAll('[data-agentsdock-comment]')) element.removeAttribute('data-agentsdock-comment');
      layer.replaceChildren();
      const located = [];
      for (const pin of pins) {
        const element = locate(pin);
        if (!element) continue;
        located.push(pin.id);
        const rect = element.getBoundingClientRect();
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = String(pin.number);
        button.title = pin.label || '';
        if (pin.id === active) { button.className = 'active'; element.setAttribute('data-agentsdock-comment', 'active'); }
        button.style.left = Math.max(0, rect.right + window.scrollX - 13) + 'px';
        button.style.top = Math.max(0, rect.top + window.scrollY - 13) + 'px';
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); post({ kind: 'comment-open', id: pin.id }); });
        layer.appendChild(button);
      }
      const summary = located.join(',');
      if (summary !== reported) { reported = summary; post({ kind: 'comment-anchors', located }); }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    return {
      set(next, nextActive) { pins = Array.isArray(next) ? next : []; active = nextActive || null; reported = null; schedule(); },
      focus(id) {
        active = id;
        const pin = pins.find(candidate => candidate.id === id);
        const element = pin && locate(pin);
        if (element && element.scrollIntoView) element.scrollIntoView({ block: 'center', inline: 'nearest' });
        schedule();
      },
    };
  })();
`

/**
 * Runs before vendor.js. The runtime posts to the WKWebView handler
 * `window.webkit.messageHandlers.zedCanvas`; this routes it to
 * react-native-webview's channel. On iOS that library keeps its own handler in
 * the same namespace, so zedCanvas is added beside it, never over it.
 */
const BRIDGE_SHIM = `
(() => {
  const PAGE = ${JSON.stringify(CANVAS_PAGE_MESSAGE_SOURCE)};
  const post = message => window.ReactNativeWebView.postMessage(JSON.stringify({ source: PAGE, message }));
  const zedCanvas = { postMessage(raw) {
    let message = raw;
    try { message = JSON.parse(raw); } catch {}
    post(message);
  } };
  const webkit = window.webkit || (window.webkit = {});
  const handlers = webkit.messageHandlers || (webkit.messageHandlers = {});
  try { Object.defineProperty(handlers, 'zedCanvas', { value: zedCanvas, configurable: true }); }
  catch { webkit.messageHandlers = Object.assign(Object.create(handlers), { zedCanvas }); }
${COMMENT_PINS_SCRIPT}
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

/** Injected calls into the page: the runtime's selection mode and the comment pins. Trailing `true;` as for find. */
export function canvasSelectingScript(selecting: boolean): string {
  const call = selecting ? 'host.setSelecting(true);' : 'host.setSelecting(false); host.clearSelection();'
  return `(() => { const host = globalThis.__zedCanvasHost; if (host) { ${call} } })(); true;`
}

export function canvasCommentPinsScript(pins: readonly CanvasCommentPin[], active: string | null): string {
  return `(() => { if (window.__agentsdockComments) window.__agentsdockComments.set(${JSON.stringify(pins)}, ${JSON.stringify(active)}); })(); true;`
}

export function canvasFocusCommentScript(id: string): string {
  return `(() => { if (window.__agentsdockComments) window.__agentsdockComments.focus(${JSON.stringify(id)}); })(); true;`
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
