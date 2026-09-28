import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

// The WebView evaluates the shipped Monaco page as one IIFE with no web worker
// available. Run that exact script against a minimal DOM stand-in: reaching
// {type:'ready'} proves the bundle has no top-level reference errors and the
// diff editor constructs; a following 'load' proves the models swap in and
// Monaco takes its documented main-thread worker fallback instead of waiting
// on a worker that can never start. The stub has no HTML parser, so Monaco's
// line renderer fails later inside a timer; those asynchronous errors are
// collected but not judged.
const assets = fs.readFileSync(path.resolve('src/editor/monacoDiffAssets.ts'), 'utf8')
const html = JSON.parse(/^export const MONACO_DIFF_HTML = (.*)$/m.exec(assets)[1])
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1]

function createPage() {
  const posted = []
  const warnings = []
  const asyncErrors = []
  const listeners = {}
  const noop = () => {}
  const guarded = fn => (...args) => { try { fn(...args) } catch (error) { asyncErrors.push(error) } }
  // Unref'd so Monaco's intervals cannot keep the test process alive.
  const later = (fn, ms, ...args) => { const timer = setTimeout(guarded(fn), ms, ...args); timer.unref(); return timer }
  const every = (fn, ms, ...args) => { const timer = setInterval(guarded(fn), ms, ...args); timer.unref(); return timer }
  const rect = { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.dataset = {}; this.attributes = {}; this.children = []; this.childNodes = []; this.parentNode = null
      this.className = ''; this.id = ''; this.textContent = ''; this.innerHTML = ''; this.innerText = ''; this.ownerDocument = null
      this.style = new Proxy({ setProperty: noop, removeProperty: () => '', getPropertyValue: () => '', cssText: '' }, { get: (target, key) => target[key] ?? '', set: (target, key, value) => (target[key] = value, true) })
      this.classList = { add: noop, remove: noop, contains: () => false, toggle: noop }
      this.sheet = { insertRule: noop, deleteRule: noop, cssRules: [], rules: [] }
    }
    appendChild(child) { this.children.push(child); this.childNodes.push(child); child.parentNode = this; return child }
    replaceChildren(...children) { this.children = children; this.childNodes = children }
    removeChild(child) { return child } insertBefore(child) { return child } replaceChild(child) { return child } remove() {} append() {} prepend() {} after() {} before() {}
    setAttribute(key, value) { this.attributes[key] = String(value) } getAttribute(key) { return this.attributes[key] ?? null } removeAttribute(key) { delete this.attributes[key] } hasAttribute(key) { return key in this.attributes }
    addEventListener() {} removeEventListener() {} dispatchEvent() { return true }
    getBoundingClientRect() { return rect } getClientRects() { return [] } getContext() { return { measureText: () => ({ width: 7 }), font: '', fillRect: noop, clearRect: noop, fillText: noop } }
    querySelector() { return null } querySelectorAll() { return [] } getElementsByTagName() { return [] } getElementsByClassName() { return [] } closest() { return null } matches() { return false } contains() { return false } cloneNode() { return new Node(this.tagName) }
    focus() {} blur() {} scrollIntoView() {} setPointerCapture() {} releasePointerCapture() {} hasPointerCapture() { return false } animate() { return { cancel: noop, finished: Promise.resolve() } } getAnimations() { return [] } checkVisibility() { return true }
    get offsetWidth() { return 800 } get offsetHeight() { return 600 } get clientWidth() { return 800 } get clientHeight() { return 600 } get scrollWidth() { return 800 } get scrollHeight() { return 600 } get offsetParent() { return null } get isConnected() { return true } get shadowRoot() { return null }
    get firstChild() { return this.childNodes[0] ?? null } get lastChild() { return this.childNodes.at(-1) ?? null } get firstElementChild() { return this.children[0] ?? null } get nextSibling() { return null } get previousSibling() { return null }
  }
  class Element extends Node {}
  class HTMLElement extends Element {}
  const document = new Node('#document')
  document.nodeType = 9
  document.documentElement = new HTMLElement('html'); document.head = new HTMLElement('head'); document.body = new HTMLElement('body')
  document.createElement = tag => { const node = new HTMLElement(tag); node.ownerDocument = document; return node }
  document.createElementNS = (_namespace, tag) => document.createElement(tag)
  document.createTextNode = text => { const node = new Node('#text'); node.textContent = text; return node }
  document.createDocumentFragment = () => new Node('#fragment')
  document.createRange = () => ({ selectNodeContents: noop, getBoundingClientRect: () => rect, getClientRects: () => [] })
  document.getSelection = () => ({ rangeCount: 0, removeAllRanges: noop, addRange: noop, getRangeAt: noop, type: 'None' })
  document.hasFocus = () => true
  document.activeElement = document.body
  document.fonts = { ready: Promise.resolve(), check: () => true, addEventListener: noop }
  document.readyState = 'complete'
  document.visibilityState = 'visible'
  document.baseURI = 'https://agentsdock.local/monaco-diff/'
  const host = document.createElement('div'); host.id = 'editor'; document.body.appendChild(host)
  document.getElementById = id => id === 'editor' ? host : null
  class Observer { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } }
  const mediaQuery = () => ({ matches: false, media: '', addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop })
  const Stub = class {}
  const window = {
    document, host, posted, warnings, asyncErrors, listeners,
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', language: 'en', languages: ['en'], platform: 'iPhone', maxTouchPoints: 5, vendor: 'Apple Computer, Inc.', clipboard: {} },
    location: { href: document.baseURI, origin: 'https://agentsdock.local', protocol: 'https:', host: 'agentsdock.local' }, origin: 'https://agentsdock.local', history: { pushState: noop, replaceState: noop, state: null },
    matchMedia: mediaQuery, getComputedStyle: () => new Proxy({}, { get: (_target, key) => key === 'getPropertyValue' ? () => '' : '' }),
    requestAnimationFrame: callback => later(() => callback(Date.now()), 0), cancelAnimationFrame: clearTimeout, requestIdleCallback: callback => later(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0), cancelIdleCallback: clearTimeout,
    setTimeout: later, clearTimeout, setInterval: every, clearInterval, queueMicrotask: callback => queueMicrotask(guarded(callback)),
    performance, console: { ...console, warn: (...args) => warnings.push(args.map(String).join(' ')) }, structuredClone, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, AbortSignal, Intl, crypto: globalThis.crypto, Blob, atob, btoa,
    devicePixelRatio: 2, innerWidth: 800, innerHeight: 600, outerWidth: 800, outerHeight: 600, screen: { width: 800, height: 600, availWidth: 800, availHeight: 600 }, scrollX: 0, scrollY: 0, visualViewport: { width: 800, height: 600, addEventListener: noop, removeEventListener: noop },
    ResizeObserver: Observer, MutationObserver: Observer, IntersectionObserver: Observer, PerformanceObserver: Observer,
    Node, Element, HTMLElement, HTMLDivElement: HTMLElement, HTMLInputElement: HTMLElement, HTMLTextAreaElement: HTMLElement, HTMLCanvasElement: HTMLElement, HTMLStyleElement: HTMLElement, HTMLSpanElement: HTMLElement, HTMLIFrameElement: HTMLElement, HTMLImageElement: HTMLElement, HTMLAnchorElement: HTMLElement, HTMLButtonElement: HTMLElement, HTMLSelectElement: HTMLElement, HTMLOptionElement: HTMLElement, HTMLLabelElement: HTMLElement, HTMLUListElement: HTMLElement, HTMLLIElement: HTMLElement, HTMLBodyElement: HTMLElement, HTMLHtmlElement: HTMLElement, HTMLHeadElement: HTMLElement, HTMLTableElement: HTMLElement, HTMLFormElement: HTMLElement, HTMLLinkElement: HTMLElement, HTMLScriptElement: HTMLElement, HTMLTemplateElement: HTMLElement, HTMLUnknownElement: HTMLElement, Image: HTMLElement, SVGElement: Element, SVGSVGElement: Element, Text: Node, Document: Node, DocumentFragment: Node, ShadowRoot: Node,
    Event: class Event { constructor(type, init) { this.type = type; Object.assign(this, init) } preventDefault() {} stopPropagation() {} }, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; Object.assign(this, init) } },
    MouseEvent: Stub, KeyboardEvent: Stub, PointerEvent: Stub, TouchEvent: Stub, WheelEvent: Stub, DragEvent: Stub, FocusEvent: Stub, InputEvent: Stub, ClipboardEvent: Stub, UIEvent: Stub, ErrorEvent: Stub, MessageEvent: Stub, CompositionEvent: Stub, AnimationEvent: Stub, TransitionEvent: Stub, ProgressEvent: Stub, StorageEvent: Stub, PopStateEvent: Stub, HashChangeEvent: Stub, BeforeUnloadEvent: Stub, Range: Stub, Selection: Stub, DOMRect: Stub, XMLSerializer: Stub, XMLHttpRequest: Stub, WebSocket: Stub, FontFace: class { load() { return Promise.resolve(this) } },
    // Present as in a real WebView, so only MonacoEnvironment.getWorker decides whether a worker exists.
    Worker: class Worker {},
    DOMParser: class { parseFromString() { return document } }, NodeFilter: {}, CSS: { escape: value => value, supports: () => true },
    customElements: { define: noop, get: () => undefined, whenDefined: () => Promise.resolve() },
    trustedTypes: undefined, localStorage: undefined, sessionStorage: undefined, indexedDB: undefined, caches: undefined, speechSynthesis: undefined, Notification: undefined, fetch: undefined,
    isSecureContext: true, crossOriginIsolated: false, name: '', status: '', closed: false, length: 0, opener: null, frameElement: null, event: undefined, onerror: null, onunhandledrejection: null,
    ReactNativeWebView: { postMessage: message => posted.push(JSON.parse(message)) },
    addEventListener: (type, listener) => { (listeners[type] ??= []).push(listener) }, removeEventListener: noop, dispatchEvent: () => true, getSelection: document.getSelection, focus: noop, open: noop, postMessage: noop, scrollTo: noop, scroll: noop, alert: noop, confirm: () => false, prompt: () => null, print: noop, close: noop, stop: noop,
  }
  window.window = window; window.self = window; window.globalThis = window; window.top = window; window.parent = window; window.frames = window
  document.defaultView = window
  return window
}

const settle = () => new Promise(resolve => setTimeout(resolve, 150))
const model = {
  path: 'src/app.ts',
  original: 'keep4\nold5\nkeep6\n⋯ 13 unchanged\nkeep20\nkeep21',
  modified: 'keep4\nnew5\nkeep6\n⋯ 13 unchanged\nkeep20\nadded\nkeep21',
  originalLineNumbers: [4, 5, 6, null, 20, 21],
  modifiedLineNumbers: [4, 5, 6, null, 20, 21, 22],
  conflicts: [{ line: 2, side: 'ours', marker: 'start' }],
}

test('the shipped Monaco page boots to ready, loads a diff on the main thread, and restyles without errors', async () => {
  const page = createPage()
  vm.runInContext(script, vm.createContext(page), { filename: 'monaco-diff-page.js' })
  await settle()
  assert.deepEqual(page.posted, [{ type: 'ready' }], 'boot posts ready and nothing else')
  assert.deepEqual(page.asyncErrors, [], 'an idle editor schedules no failing work')
  assert.equal(page.host.children[0]?.className, 'monaco-diff-editor side-by-side')

  // Monaco registers its own window 'message' listener next to the page's; both receive the host message, as in a WebView.
  const deliver = message => { for (const listener of page.listeners.message) listener({ data: JSON.stringify(message) }) }
  deliver({ type: 'load', ...model, sideBySide: true, wordWrap: false, theme: 'dark', fontSize: 12 })
  assert.deepEqual(page.posted, [{ type: 'ready' }], 'load raises no protocol error')
  assert.equal(page.document.body.dataset.theme, 'dark')
  await settle()
  assert.ok(page.warnings.some(warning => warning.includes('Falling back to loading web worker code in main thread')), `Monaco took its in-process worker fallback; warnings: ${JSON.stringify(page.warnings)}`)
  assert.ok(page.warnings.some(warning => warning.includes('Web workers are unavailable inside the review WebView')), 'the fallback was triggered by the page\'s own getWorker, not by a missing browser API')

  deliver({ type: 'options', sideBySide: false, wordWrap: true, theme: 'light' })
  assert.equal(page.document.body.dataset.theme, 'light')
  deliver({ type: 'load', ...model, path: 'README.md', sideBySide: false, wordWrap: true, theme: 'light', fontSize: 12 })
  assert.deepEqual(page.posted, [{ type: 'ready' }], 'options and a second load (model swap) raise no protocol error')
})
