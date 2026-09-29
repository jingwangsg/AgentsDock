// Offline pdf.js page for Android, whose WebView has no PDF renderer (iOS
// shows PDFs natively). Pages render lazily near the viewport, pinch zoom is
// the WebView's own, and visible pages re-render sharp once a zoom settles.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs'

// Host protocol. Host -> page: {type:'begin', size, background} then
// {type:'chunk', offset, data(base64)} until {type:'end'}; {type:'theme',
// background} restyles. Page -> host: {type:'ready'} once listening,
// {type:'loaded', pages}, {type:'page', page, pages} when the page under the
// viewport centre changes, {type:'error', message} for any failure. One
// document per page load: the host remounts the WebView for another file.
type HostMessage =
  | { type: 'begin'; size: number; background: string }
  | { type: 'chunk'; offset: number; data: string }
  | { type: 'end' }
  | { type: 'theme'; background: string }

type AssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'

// Base64 files keyed by pdf.js asset kind and file name, prepended to this
// bundle by scripts/embed-pdf-viewer.mjs.
declare const PDF_ASSETS: Record<AssetKind, Record<string, string>>

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void }
  }
}

// Each backing store costs 4 bytes per pixel; a zoomed page may not exceed this.
const MAX_CANVAS_PIXELS = 16_000_000
// Pages within this distance of the viewport keep their canvas; the rest are released.
const RENDER_MARGIN = '150% 0px'
const PAGE_GAP_PX = 8

interface PageSlot {
  number: number
  element: HTMLDivElement
  canvas: HTMLCanvasElement
  textLayer: HTMLDivElement
  near: boolean
  // Pixel ratio of the current backing store; 0 while released.
  renderedRatio: number
  // The ratio at which this page reaches MAX_CANVAS_PIXELS; known after its first render.
  maxRatio: number
  task: { cancel: () => void } | null
  text: pdfjs.TextLayer | null
}

function post(message: { type: 'ready' } | { type: 'loaded'; pages: number } | { type: 'page'; page: number; pages: number } | { type: 'error'; message: string }): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(message))
}

function describe(error: unknown): string {
  if (error instanceof pdfjs.PasswordException) return 'This PDF is password protected.'
  if (error instanceof pdfjs.InvalidPDFException) return 'The file is not a valid PDF.'
  return error instanceof Error ? error.message : String(error)
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

// Replaces pdf.js's fetch-based loader: CMaps, the two non-substitutable
// standard fonts and the image-decoder wasm come from the embedded map.
class EmbeddedBinaryDataFactory {
  async fetch({ kind, filename }: { kind: AssetKind; filename: string }): Promise<Uint8Array> {
    const data = PDF_ASSETS[kind]?.[filename]
    if (!data) throw new Error(`The PDF viewer does not bundle ${filename}.`)
    return decodeBase64(data)
  }
}

// A page loaded from an HTML string has no URL to start a worker from; with the
// worker module on globalThis, pdf.js runs its "fake worker" on this thread.
;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

const root = document.getElementById('pages') as HTMLDivElement
let document_: pdfjs.PDFDocumentProxy | null = null
let slots: PageSlot[] = []
let buffer: Uint8Array | null = null
let received = 0
let currentPage = 0
let rendering = false
let layoutWidth = 0

function outputRatio(slot: PageSlot): number {
  return Math.min((window.devicePixelRatio || 1) * (window.visualViewport?.scale ?? 1), slot.maxRatio)
}

async function renderSlot(slot: PageSlot): Promise<void> {
  if (!document_) return
  const page = await document_.getPage(slot.number)
  if (!slot.near) return
  const base = page.getViewport({ scale: 1 })
  const cssWidth = root.clientWidth
  const viewport = page.getViewport({ scale: cssWidth / base.width })
  // The placeholder used the first page's shape; settle this page's own.
  slot.element.style.aspectRatio = `${base.width} / ${base.height}`
  slot.element.style.setProperty('--total-scale-factor', String(viewport.scale))

  slot.maxRatio = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))
  const ratio = outputRatio(slot)
  const canvas = slot.canvas
  canvas.width = Math.floor(viewport.width * ratio)
  canvas.height = Math.floor(viewport.height * ratio)
  const task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
  slot.task = task
  try {
    await task.promise
  } finally {
    slot.task = null
  }
  slot.renderedRatio = ratio

  if (!slot.text) {
    slot.text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: slot.textLayer, viewport })
    await slot.text.render()
  }
}

function release(slot: PageSlot): void {
  slot.task?.cancel()
  slot.task = null
  slot.canvas.width = 0
  slot.canvas.height = 0
  slot.renderedRatio = 0
  slot.text?.cancel()
  slot.text = null
  slot.textLayer.replaceChildren()
}

// One page at a time, nearest to the current page first, so a fling does not
// queue dozens of renders on the only thread this page has.
async function renderQueue(): Promise<void> {
  if (rendering) return
  rendering = true
  try {
    for (;;) {
      const stale = slots
        .filter(slot => slot.near && Math.abs(slot.renderedRatio - outputRatio(slot)) > outputRatio(slot) * 0.2)
        .sort((a, b) => Math.abs(a.number - currentPage) - Math.abs(b.number - currentPage))[0]
      if (!stale) break
      try {
        await renderSlot(stale)
      } catch (error) {
        if (!(error instanceof pdfjs.RenderingCancelledException)) throw error
      }
    }
  } catch (error) {
    post({ type: 'error', message: describe(error) })
  } finally {
    rendering = false
  }
}

function updateCurrentPage(): void {
  if (!slots.length) return
  const viewport = window.visualViewport
  const middle = (viewport ? viewport.pageTop + viewport.height / 2 : window.scrollY + window.innerHeight / 2)
  let low = 0
  let high = slots.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (slots[mid]!.element.offsetTop <= middle) low = mid
    else high = mid - 1
  }
  const page = low + 1
  if (page === currentPage) return
  currentPage = page
  post({ type: 'page', page, pages: slots.length })
}

async function open(data: Uint8Array): Promise<void> {
  const loadingTask = pdfjs.getDocument({
    data,
    BinaryDataFactory: EmbeddedBinaryDataFactory,
    // No new Function() for fonts; CSP forbids it anyway.
    isEvalSupported: false,
    enableXfa: false,
  } as Parameters<typeof pdfjs.getDocument>[0])
  document_ = await loadingTask.promise
  const first = (await document_.getPage(1)).getViewport({ scale: 1 })

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const slot = slots[Number((entry.target as HTMLElement).dataset.page) - 1]
      if (!slot) continue
      slot.near = entry.isIntersecting
      if (!slot.near && slot.renderedRatio) release(slot)
    }
    void renderQueue()
  }, { rootMargin: RENDER_MARGIN })

  slots = Array.from({ length: document_.numPages }, (_, index) => {
    const element = document.createElement('div')
    element.className = 'page'
    element.dataset.page = String(index + 1)
    element.style.aspectRatio = `${first.width} / ${first.height}`
    const canvas = document.createElement('canvas')
    const textLayer = document.createElement('div')
    textLayer.className = 'textLayer'
    element.append(canvas, textLayer)
    root.append(element)
    observer.observe(element)
    return { number: index + 1, element, canvas, textLayer, near: false, renderedRatio: 0, maxRatio: Infinity, task: null, text: null }
  })
  layoutWidth = root.clientWidth
  post({ type: 'loaded', pages: slots.length })
  updateCurrentPage()
}

let zoomTimer: ReturnType<typeof setTimeout> | null = null
function onViewportChange(): void {
  updateCurrentPage()
  // Re-render at the new zoom only once the pinch settles.
  if (zoomTimer) clearTimeout(zoomTimer)
  zoomTimer = setTimeout(() => { void renderQueue() }, 250)
}

// Folding or rotating changes the page width: every canvas and text layer was
// laid out for the old one. Pinch zoom only resizes the visual viewport.
function onLayoutChange(): void {
  if (root.clientWidth === layoutWidth) return
  layoutWidth = root.clientWidth
  for (const slot of slots) if (slot.renderedRatio) release(slot)
  void renderQueue()
}

function receive(event: MessageEvent): void {
  let message: HostMessage
  try { message = JSON.parse(event.data) } catch { return }
  try {
    if (message.type === 'begin') {
      document.body.style.background = message.background
      buffer = new Uint8Array(message.size)
      received = 0
    } else if (message.type === 'chunk' && buffer) {
      const bytes = decodeBase64(message.data)
      buffer.set(bytes, message.offset)
      received += bytes.length
    } else if (message.type === 'end' && buffer) {
      if (received !== buffer.length) throw new Error(`Received ${received} of ${buffer.length} PDF bytes.`)
      const data = buffer
      buffer = null
      void open(data).catch(error => post({ type: 'error', message: describe(error) }))
    } else if (message.type === 'theme') {
      document.body.style.background = message.background
    }
  } catch (error) {
    post({ type: 'error', message: describe(error) })
  }
}

try {
  document.documentElement.style.setProperty('--page-gap', `${PAGE_GAP_PX}px`)
  window.addEventListener('error', event => post({ type: 'error', message: describe(event.error ?? event.message) }))
  window.addEventListener('unhandledrejection', event => post({ type: 'error', message: describe(event.reason) }))
  window.addEventListener('scroll', updateCurrentPage, { passive: true })
  window.addEventListener('resize', onLayoutChange)
  window.visualViewport?.addEventListener('resize', onViewportChange)
  window.visualViewport?.addEventListener('scroll', updateCurrentPage)
  window.addEventListener('message', receive)
  document.addEventListener('message', receive as EventListener)
  post({ type: 'ready' })
} catch (error) {
  post({ type: 'error', message: describe(error) })
}
