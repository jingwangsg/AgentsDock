/**
 * Assembles the sandboxed page a Canvas renders in, mirroring
 * electron/src/main/canvas-protocol.ts: the server's shell.html with data: URL
 * scripts for a bridge shim, vendor.js, the compiled report and the mount call.
 * The shell's CSP (`script-src data:`, `connect-src 'none'`) keeps reports
 * offline; base64 keeps a `</script>` inside a report from ending its tag.
 * Pure: no React Native imports, so it runs under node for tests.
 */

import { base64 } from './base64'

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
  /** From the floating table of contents: whether the page has two or more headings to list. */
  | { kind: 'toc'; available: boolean }
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
 * Floating table of contents, installed as window.__agentsdockToc: the report's h1–h3
 * (the SDK's H1/H2/H3 and CardHeader titles) as a panel at the right edge that marks
 * the section in view and scrolls to a heading when its entry is tapped. The host
 * decides whether it shows (`show`); the page draws it only for two or more headings
 * and reports whether it has them whenever the headings change. Touch screens keep it
 * open; where the primary pointer can hover it rests as a strip at the edge until the
 * pointer reaches it.
 * Identical in electron/src/main/canvas-protocol.ts.
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
${TOC_SCRIPT}
})();
`

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

/** Injected calls into the page: the runtime's selection mode, the comment pins and the table of contents. Trailing `true;` as for find. */
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

export function canvasTocScript(visible: boolean): string {
  return `(() => { if (window.__agentsdockToc) window.__agentsdockToc.show(${visible}); })(); true;`
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
