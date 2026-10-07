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

/**
 * Comment pins, installed as window.__agentsdockComments by both shims: a numbered
 * marker on the element each open thread is about, in a layer outside #root so
 * React never sees it, re-placed whenever the report's layout changes. An anchor
 * is found by data-canvas-id, then by tag and leading text; threads whose element
 * is gone from this revision get no pin and are reported as not located.
 * Mirrored in mobile-react/src/lib/canvas-page.ts.
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
          + '#agentsdock-comment-pins button{position:absolute;min-width:22px;height:22px;margin:0;padding:0 6px;border:2px solid var(--canvas-background);border-radius:11px 11px 11px 2px;background:var(--canvas-accent);color:var(--canvas-background);font:700 11px/16px -apple-system,sans-serif;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35)}'
          + '#agentsdock-comment-pins button.active{transform:scale(1.25)}'
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
        button.style.left = Math.max(0, rect.right + window.scrollX - 12) + 'px';
        button.style.top = Math.max(0, rect.top + window.scrollY - 12) + 'px';
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
 * Floating table of contents, installed as window.__agentsdockToc by both shims: the
 * report's h1–h3 (the SDK's H1/H2/H3 and CardHeader titles) as a panel at the right
 * edge that marks the section in view and scrolls to a heading when its entry is
 * clicked. The host decides whether it shows (`show`); the page draws it only for
 * two or more headings and reports whether it has them whenever the headings change.
 * With a mouse it rests as a strip at the edge and slides out when the pointer
 * reaches the edge beside it; touch screens keep it open.
 * Identical in mobile-react/src/lib/canvas-page.ts.
 */
export const TOC_SCRIPT = `
  window.__agentsdockToc = (() => {
    const norm = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const root = document.getElementById('root') || document.body;
    // An unstyled custom element whose shadow root holds the panel: the report's CSS (say nav{display:flex} or the
    // shell's global button style) cannot reach it, and in-page find does not walk into it.
    const container = document.createElement('agentsdock-toc');
    const shadow = container.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>'
      + 'nav{box-sizing:border-box;position:fixed;z-index:2147483645;top:50%;right:12px;transform:translateY(-50%);max-width:min(240px,45vw);max-height:70vh;overflow:auto;overscroll-behavior:contain;padding:6px 0;border:1px solid var(--canvas-border);border-radius:8px;background:var(--canvas-background);box-shadow:0 4px 16px rgba(0,0,0,.25);font:12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif}'
      + 'button{display:block;width:100%;margin:0;padding:3px 12px;border:0;border-left:2px solid transparent;background:none;color:var(--canvas-muted);font:inherit;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}'
      + 'button:hover{color:var(--canvas-foreground)}'
      + 'button.active{color:var(--canvas-accent);border-left-color:var(--canvas-accent)}'
      // Translucent where color-mix exists; a var() inside an unsupported color-mix would leave no background at all.
      + '@supports (background:color-mix(in srgb,red,red)){nav{background:color-mix(in srgb,var(--canvas-background) 55%,transparent);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}}'
      // Where a mouse can hover, the panel rests moved right by its width + 6px: 12px from the edge, that leaves a 6px
      // strip showing the current entry's accent bar. .open, set below, slides it out. :focus-visible, not :focus-within,
      // so keyboard focus brings it out but focus from a mouse press does not hold it out.
      + '@media (hover:hover) and (pointer:fine){nav{transform:translate(calc(100% + 6px),-50%);transition:transform .18s ease}nav.open,nav:has(:focus-visible){transform:translateY(-50%)}}'
      + '@media (pointer:coarse){button{padding-top:8px;padding-bottom:8px}}</style><nav hidden></nav>';
    const nav = shadow.querySelector('nav');
    // Hidden while the user picks an element to comment on, so a pick never lands on the table of contents.
    const selectingStyle = document.createElement('style');
    selectingStyle.textContent = 'body.zed-selecting>agentsdock-toc{display:none}';
    document.head.appendChild(selectingStyle);
    document.body.appendChild(container);
    let visible = false, headings = [], buttons = [], signature = null, active = -1, frame = 0;
    const spy = () => {
      let next = 0;
      // Scrolled to the end, the last sections can never reach the top edge: the last heading is current.
      const atEnd = window.scrollY > 0 && window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      headings.forEach((heading, index) => {
        const { top, height } = heading.getBoundingClientRect();
        // A heading inside a display:none subtree measures 0x0 at the top edge; it is never the section in view.
        if (height && (atEnd || top <= 48)) next = index;
      });
      if (next === active) return;
      if (buttons[active]) buttons[active].classList.remove('active');
      active = next;
      const button = buttons[active];
      button.classList.add('active');
      // Keep the current entry inside a long table of contents by scrolling the panel only, never the report.
      if (button.offsetTop < nav.scrollTop || button.offsetTop + button.offsetHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = button.offsetTop - nav.clientHeight / 2;
    };
    const collect = () => {
      frame = 0;
      headings = [...root.querySelectorAll('h1,h2,h3')].filter(heading => norm(heading.textContent));
      const available = headings.length >= 2;
      const next = headings.map(heading => heading.tagName + norm(heading.textContent)).join('\\n');
      if (next !== signature) {
        signature = next;
        const topLevel = Math.min(...headings.map(heading => Number(heading.tagName[1])));
        buttons = headings.map((heading, index) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = button.title = norm(heading.textContent);
          button.style.paddingLeft = (12 + (Number(heading.tagName[1]) - topLevel) * 12) + 'px';
          // By index: a re-render can replace a heading element without changing its level or text, which keeps these buttons.
          button.addEventListener('click', event => {
            // A mouse click (detail > 0) leaves no focus behind: the next key press would make the entry :focus-visible.
            if (event.detail) button.blur();
            headings[index].scrollIntoView({ block: 'start', behavior: 'smooth' });
          });
          return button;
        });
        nav.replaceChildren(...buttons);
        active = -1;
        post({ kind: 'toc', available });
      }
      nav.hidden = !visible || !available;
      if (!nav.hidden) spy();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(collect); };
    new MutationObserver(schedule).observe(root, { subtree: true, childList: true, characterData: true });
    window.addEventListener('scroll', () => { if (!nav.hidden) schedule(); }, { passive: true });
    schedule();
    // Out while the pointer is level with the panel and at most 10px left of it: at rest that includes the edge beside
    // the strip, so the 6px strip itself need not be hit. Back 300ms after the pointer leaves that area, so a brief
    // stray on the way to an entry keeps it out.
    let closing = 0;
    const slideBack = () => {
      if (!closing && nav.classList.contains('open')) closing = setTimeout(() => { closing = 0; nav.classList.remove('open'); }, 300);
    };
    // Capture phase: a report handler that stops propagation cannot hide moves from it.
    document.addEventListener('mousemove', event => {
      // 0x0 while hidden or under the element picker's display:none, so never inside: it shows again at rest.
      const { left, top, bottom, height } = nav.getBoundingClientRect();
      // Once out, measure from where it slides to (offsetLeft ignores the transform): a pointer that stopped ahead of
      // the sliding panel gets no further move when the panel arrives under it.
      const start = nav.classList.contains('open') ? nav.offsetLeft : left;
      if (height && event.clientX >= start - 10 && event.clientY >= top && event.clientY <= bottom) { clearTimeout(closing); closing = 0; nav.classList.add('open'); }
      else slideBack();
    }, true);
    // A pointer that leaves the page sends no further moves.
    document.addEventListener('mouseout', event => { if (!event.relatedTarget) slideBack(); }, true);
    return { show(next) { visible = !!next; schedule(); } };
  })();
`

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

${COMMENT_PINS_SCRIPT}
${TOC_SCRIPT}
  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== HOST || typeof data.call !== 'string') return;
    if (data.call === 'find') { runFind(data.args && data.args[0], data.args && data.args[1]); return; }
    if (data.call === 'clear-find') { clearFind(); reportFind(); return; }
    if (data.call === 'set-comments') { window.__agentsdockComments.set(data.args && data.args[0], data.args && data.args[1]); return; }
    if (data.call === 'focus-comment') { window.__agentsdockComments.focus(data.args && data.args[0]); return; }
    if (data.call === 'set-toc') { window.__agentsdockToc.show(data.args && data.args[0]); return; }
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
