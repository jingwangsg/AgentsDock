/**
 * agentsdock-canvas:// pages.
 *
 * A Canvas preview is an opaque-origin sandboxed iframe whose document is
 * assembled here, mirroring Zed's canvas_html: the shell page from the server
 * runtime plus data: URL scripts for vendor.js, the compiled report, and the
 * mount call. The shell's own CSP (`script-src data:`, `connect-src 'none'`)
 * keeps the report offline. A small shim replaces the WKWebView message
 * handler the runtime expects with window.postMessage to the parent, and lets
 * the parent call the runtime's host API (theme, state, element selection).
 */

import {
  CANVAS_HOST_MESSAGE_SOURCE,
  CANVAS_NAME_PATTERN,
  CANVAS_PAGE_MESSAGE_SOURCE,
  CANVAS_SCHEME,
  type CanvasHostTheme,
  type CanvasPageResource
} from '../shared/canvas'

// index.ts and service.ts import the protocol surface from this module.
export { CANVAS_SCHEME }
export type { CanvasHostTheme }

const DEFAULT_THEME: CanvasHostTheme = {
  background: '#282c33', foreground: '#dce0e5', muted: '#a9afbc', border: '#464b57', accent: '#74ade8', kind: 'dark'
}

export function parseCanvasURL(value: string): CanvasPageResource | null {
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== `${CANVAS_SCHEME}:` || url.host !== 'canvas') return null
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.length !== 5 || parts[4] !== 'index.html') return null
  const [profileId, generation, sessionId, name] = parts
  const profileGeneration = Number(generation)
  if (!profileId || !sessionId || !Number.isInteger(profileGeneration) || !CANVAS_NAME_PATTERN.test(name)) return null
  return { profileId, profileGeneration, sessionId, name, theme: parseTheme(url.searchParams.get('theme')) }
}

function parseTheme(raw: string | null): CanvasHostTheme {
  if (!raw) return DEFAULT_THEME
  try {
    const value = JSON.parse(raw) as Partial<CanvasHostTheme>
    const color = (candidate: unknown, fallback: string): string =>
      typeof candidate === 'string' && /^[#a-zA-Z0-9(),.% -]{1,64}$/.test(candidate) ? candidate : fallback
    return {
      background: color(value.background, DEFAULT_THEME.background),
      foreground: color(value.foreground, DEFAULT_THEME.foreground),
      muted: color(value.muted, DEFAULT_THEME.muted),
      border: color(value.border, DEFAULT_THEME.border),
      accent: color(value.accent, DEFAULT_THEME.accent),
      kind: value.kind === 'light' ? 'light' : 'dark'
    }
  } catch {
    return DEFAULT_THEME
  }
}

/** Runs before vendor.js: bridges the runtime's WKWebView channel to postMessage in both directions. */
const BRIDGE_SHIM = `
(() => {
  const PAGE = ${JSON.stringify(CANVAS_PAGE_MESSAGE_SOURCE)};
  const HOST = ${JSON.stringify(CANVAS_HOST_MESSAGE_SOURCE)};
  const post = message => window.parent.postMessage({ source: PAGE, message }, '*');
  window.webkit = { messageHandlers: { zedCanvas: { postMessage(raw) {
    let message = raw;
    try { message = JSON.parse(raw); } catch {}
    post(message);
  } } } };

  // In-page find: a cross-document iframe cannot be searched from the host, so
  // the 'find'/'clear-find' host calls run here. Matches are painted with the CSS
  // Custom Highlight API (it decorates ranges without touching the DOM, so it
  // never fights the runtime's React tree) and the count is reported back.
  let ranges = [], at = -1;
  const ready = () => window.CSS && CSS.highlights && document.body;
  const ensureStyle = () => {
    if (!ready() || ensureStyle.done) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('::highlight(canvas-find){background:rgba(250,204,21,.45);color:inherit}::highlight(canvas-find-active){background:#f97316;color:#14181f}');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      ensureStyle.done = true;
    } catch (error) {}
  };
  const clearFind = () => {
    ranges = []; at = -1;
    if (window.CSS && CSS.highlights) { CSS.highlights.delete('canvas-find'); CSS.highlights.delete('canvas-find-active'); }
  };
  const reportFind = () => post({ type: 'find-result', total: ranges.length, active: ranges.length ? at + 1 : 0 });
  const collect = (query, matchCase) => {
    const found = [], needle = matchCase ? query : query.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, node =>
      node.nodeValue && node.nodeValue.trim() && !(node.parentElement && node.parentElement.closest('script,style,noscript'))
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT);
    for (let node; (node = walker.nextNode());) {
      const hay = matchCase ? node.nodeValue : node.nodeValue.toLowerCase();
      for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) {
        const range = document.createRange();
        range.setStart(node, i); range.setEnd(node, i + query.length);
        found.push(range);
      }
    }
    return found;
  };
  const paintActive = () => {
    if (!ready()) return;
    if (at < 0) { CSS.highlights.delete('canvas-find-active'); return; }
    CSS.highlights.set('canvas-find-active', new Highlight(ranges[at]));
    const anchor = ranges[at].startContainer.parentElement;
    if (anchor && anchor.scrollIntoView) anchor.scrollIntoView({ block: 'center', inline: 'nearest' });
  };
  const runFind = (query, options) => {
    options = options || {};
    if (!query || !ready()) { clearFind(); reportFind(); return; }
    if (options.findNext && ranges.length) {
      at = (at + (options.forward === false ? -1 : 1) + ranges.length) % ranges.length;
    } else {
      ensureStyle();
      ranges = collect(query, !!options.matchCase);
      at = ranges.length ? 0 : -1;
      CSS.highlights.set('canvas-find', new Highlight(...ranges));
    }
    paintActive();
    reportFind();
  };

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== HOST || typeof data.call !== 'string') return;
    if (data.call === 'find') { runFind(data.args && data.args[0], data.args && data.args[1]); return; }
    if (data.call === 'clear-find') { clearFind(); reportFind(); return; }
    const host = globalThis.__zedCanvasHost;
    if (!host || typeof host[data.call] !== 'function') return;
    try { host[data.call](...(Array.isArray(data.args) ? data.args : [])); }
    catch (error) { post({ kind: 'error', error: String(error) }); }
  });
})();
`

export function buildCanvasPage(input: {
  shell: string
  vendor: string
  javascript: string
  state: Record<string, unknown>
  theme: CanvasHostTheme
}): string {
  const mount = `__zedCanvasHost.mount(${JSON.stringify(input.state)}, ${JSON.stringify(input.theme)});`
  const scripts = [BRIDGE_SHIM, input.vendor, input.javascript, mount]
    .map(source => `<script src="data:application/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}"></script>`)
    .join('')
  if (!input.shell.includes('<!--CANVAS_SCRIPTS-->')) throw new Error('Canvas shell is missing its script placeholder.')
  return input.shell.replace('<!--CANVAS_SCRIPTS-->', scripts)
}

export function canvasNotFoundResponse(message = 'Canvas not found'): Response {
  return new Response(message, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}

export function canvasErrorPage(title: string, detail: string): string {
  const escape = (value: string) => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]!)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:13px -apple-system,sans-serif;padding:24px;color:#d07277;background:transparent}pre{white-space:pre-wrap;color:inherit;opacity:.85}</style></head><body><strong>${escape(title)}</strong><pre>${escape(detail)}</pre></body></html>`
}
