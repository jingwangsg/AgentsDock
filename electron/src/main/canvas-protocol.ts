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
  window.webkit = { messageHandlers: { zedCanvas: { postMessage(raw) {
    let message = raw;
    try { message = JSON.parse(raw); } catch {}
    window.parent.postMessage({ source: PAGE, message }, '*');
  } } } };
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== HOST || typeof data.call !== 'string') return;
    const host = globalThis.__zedCanvasHost;
    if (!host || typeof host[data.call] !== 'function') return;
    try { host[data.call](...(Array.isArray(data.args) ? data.args : [])); }
    catch (error) { window.parent.postMessage({ source: PAGE, message: { kind: 'error', error: String(error) } }, '*'); }
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
