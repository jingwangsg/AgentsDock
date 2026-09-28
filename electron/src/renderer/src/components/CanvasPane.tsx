import { CANVAS_HOST_MESSAGE_SOURCE, CANVAS_NAME_PATTERN, CANVAS_PAGE_MESSAGE_SOURCE, canvasPageURL, type CanvasHostTheme } from '@shared/canvas'
import { t } from '@shared/i18n'
import type { CanvasRecord, CanvasSummary, Session } from '@shared/types'
import { Crosshair, Eye, FileCode2, RefreshCw, X } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { saveLocalStorage } from '../lib/local-storage'
import { notifyTimelineViewportLayout } from '../lib/workspace-layout'
import { useAppStore } from '../store/app-store'
import './CanvasPane.css'

export interface CanvasTarget {
  sessionId: string
  name: string
}

interface SelectedElement {
  id: string | null
  tag: string
  text: string
  html: string
}

type CanvasAction =
  | { type: 'askAgent'; prompt: string }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'openAgent'; sessionId: string }

type PageMessage =
  | { kind: 'ready' }
  | { kind: 'state'; key: string; value: unknown }
  | { kind: 'action'; action: CanvasAction }
  | { kind: 'error'; error: string }
  | { kind: 'selection'; elements: SelectedElement[]; complete: boolean }
  | { kind: 'link'; url: string }

const CANVAS_SUFFIX = '.canvas.tsx'
const STATE_SAVE_DELAY_MS = 400
const CANVAS_WIDTH_KEY = 'agentsdock:canvas-width'

export function canvasWidthStorageKey(workspaceKey: string): string {
  return `${CANVAS_WIDTH_KEY}:${encodeURIComponent(workspaceKey)}`
}

/** "…/report.canvas.tsx" (path, URL or file: link) -> "report"; null when it is not a Canvas path. */
export function canvasNameFromPath(value: string | null | undefined): string | null {
  if (!value) return null
  const clean = value.replace(/^file:\/\//, '').split(/[?#]/)[0]
  if (!clean.endsWith(CANVAS_SUFFIX)) return null
  const name = decodeURIComponent(clean.slice(clean.lastIndexOf('/') + 1, -CANVAS_SUFFIX.length))
  return CANVAS_NAME_PATTERN.test(name) ? name : null
}

function hostTheme(): CanvasHostTheme {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    background: read('--bg', '#282c33'),
    foreground: read('--text', '#dce0e5'),
    muted: read('--muted', '#a9afbc'),
    border: read('--border', '#464b57'),
    accent: read('--accent', '#74ade8'),
    kind: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  }
}

function appendDraft(sessionId: string, text: string): void {
  const store = useAppStore.getState()
  const current = store.drafts[sessionId] ?? ''
  store.setDraftForSession(sessionId, current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text)
}

export function CanvasPane({ workspaceKey, session, target, onClose }: { workspaceKey: string; session: Session; target: CanvasTarget; onClose: () => void }) {
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const [name, setName] = useState(target.name)
  const [canvases, setCanvases] = useState<CanvasSummary[]>([])
  const [record, setRecord] = useState<CanvasRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [view, setView] = useState<'preview' | 'source'>('preview')
  const [reloadToken, setReloadToken] = useState(0)
  const [selecting, setSelecting] = useState(false)
  const [selection, setSelection] = useState<SelectedElement[] | null>(null)
  const [feedback, setFeedback] = useState('')
  const iframeRef = useRef<HTMLIFrameElement>(null)
  /** Full persistent state of the canvas on screen; the page reports one key at a time and the server replaces the file wholesale. */
  const stateRef = useRef<Record<string, unknown>>({})
  /** Snapshot awaiting its debounced PUT. It carries its own name so switching canvases cannot redirect it. */
  const pendingSave = useRef<{ name: string; state: Record<string, unknown> } | null>(null)
  const saveTimer = useRef<number | null>(null)

  // Keyed on the object, not the name: re-clicking the same link after picking another canvas in the <select> must switch back.
  useEffect(() => { setName(target.name) }, [target])

  const flushSave = useCallback(async () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    const pending = pendingSave.current
    pendingSave.current = null
    if (!pending) return
    try {
      await window.agentsDock.canvas.putState(session.id, pending.name, pending.state)
    } catch (caught) {
      // pageError renders beside the iframe; `error` would replace it and destroy the live canvas.
      setPageError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [session.id])

  const load = useCallback(async () => {
    setError(null)
    try {
      // A reload must read back the last edit, not the state the server held before the pending PUT.
      await flushSave()
      const [list, current] = await Promise.all([
        window.agentsDock.canvas.list(session.id),
        window.agentsDock.canvas.get(session.id, name)
      ])
      setCanvases(list.canvases)
      setRecord(current)
      stateRef.current = current.state ?? {}
    } catch (caught) {
      setRecord(null)
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [flushSave, name, session.id])

  useEffect(() => { void load() }, [load, reloadToken])

  // A history rewind deletes the canvases it covers: re-list, and leave when the open one is gone.
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== session.id) return
      void window.agentsDock.canvas.list(session.id)
        .then(list => list.canvases.some(canvas => canvas.name === name))
        // Unknown → keep the pane; load() surfaces the error itself.
        .catch(() => true)
        .then(present => { if (present) setReloadToken(token => token + 1); else onClose() })
    }
    window.addEventListener('agentsdock:canvases-changed', changed)
    return () => window.removeEventListener('agentsdock:canvases-changed', changed)
  }, [name, onClose, session.id])

  // Flush when the pane switches canvases and when it unmounts, so the last reported change is not dropped.
  useEffect(() => () => { void flushSave() }, [flushSave, name])

  const postToPage = useCallback((call: string, args: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage({ source: CANVAS_HOST_MESSAGE_SOURCE, call, args }, '*')
  }, [])

  const handleAction = useCallback((action: CanvasAction) => {
    if (action.type === 'askAgent' && record) {
      appendDraft(session.id, `Canvas ${record.path}: ${action.prompt}`)
    } else if (action.type === 'openFile') {
      window.dispatchEvent(new CustomEvent('agentsdock:open-workspace-path', { detail: { sessionId: session.id, path: action.path } }))
    }
    // openAgent targets another chat; this pane belongs to one chat, so it is ignored.
  }, [record, session.id])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return
      const data = event.data as { source?: string; message?: PageMessage } | null
      if (data?.source !== CANVAS_PAGE_MESSAGE_SOURCE || !data.message) return
      const message = data.message
      switch (message.kind) {
        case 'ready':
          setPageError(null)
          break
        case 'state': {
          stateRef.current = { ...stateRef.current, [message.key]: message.value }
          pendingSave.current = { name, state: stateRef.current }
          if (saveTimer.current) window.clearTimeout(saveTimer.current)
          saveTimer.current = window.setTimeout(() => { void flushSave() }, STATE_SAVE_DELAY_MS)
          break
        }
        case 'action':
          handleAction(message.action)
          break
        case 'error':
          setPageError(message.error)
          break
        case 'selection':
          setSelection(message.elements.length ? message.elements : null)
          if (message.complete) setSelecting(false)
          break
        case 'link':
          if (/^https?:\/\//i.test(message.url)) void window.agentsDock.native.openExternal(message.url)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [flushSave, handleAction, name])

  // Follow the app's light/dark switch inside the frame.
  useEffect(() => {
    const observer = new MutationObserver(() => postToPage('updateTheme', [hostTheme()]))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin'] })
    return () => observer.disconnect()
  }, [postToPage])

  const src = useMemo(() => {
    if (!profileId || !record || record.diagnostics || !record.javascript) return null
    return canvasPageURL({ profileId, profileGeneration, sessionId: session.id, name, theme: hostTheme(), reloadKey: `${record.revision}-${reloadToken}` })
  }, [name, profileGeneration, profileId, record, reloadToken, session.id])

  const toggleSelecting = () => {
    const next = !selecting
    setSelecting(next)
    if (!next) setSelection(null)
    postToPage('setSelecting', [next])
  }

  const addToChat = () => {
    if (!record || !selection || !feedback.trim()) return
    const elements = selection.map(element => ({ id: element.id, tag: element.tag, text: element.text.slice(0, 400) }))
    appendDraft(session.id, [
      `Canvas ${record.path} (revision ${record.revision}) feedback on selected elements:`,
      JSON.stringify(elements, null, 2),
      `Requested change: ${feedback.trim()}`
    ].join('\n'))
    setSelection(null)
    setFeedback('')
    postToPage('clearSelection')
  }

  // The chosen width lives on the conversation pane because the chat column beside the Canvas reads it too;
  // CanvasPane.css clamps it so neither side collapses on a smaller window.
  const paneRef = useRef<HTMLElement>(null)
  const resizeDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  useLayoutEffect(() => {
    const host = paneRef.current?.parentElement
    if (!host) return
    const saved = Number(window.localStorage.getItem(canvasWidthStorageKey(workspaceKey)))
    if (saved > 0) host.style.setProperty('--canvas-pane-user-width', `${saved}px`)
    return () => {
      host.style.removeProperty('--canvas-pane-user-width')
      document.body.classList.remove('canvas-resizing')
    }
  }, [workspaceKey])

  const setUserWidth = (width: number | null) => {
    const hostStyle = paneRef.current?.parentElement?.style
    if (width === null) hostStyle?.removeProperty('--canvas-pane-user-width')
    else hostStyle?.setProperty('--canvas-pane-user-width', `${Math.round(width)}px`)
  }
  // Keep the clamped width that rendered, so a drag past the limit does not reopen wider on a larger window.
  const commitWidth = () => {
    const width = Math.round(paneRef.current?.getBoundingClientRect().width ?? 0)
    if (!width) return
    setUserWidth(width)
    saveLocalStorage(canvasWidthStorageKey(workspaceKey), String(width))
  }
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!paneRef.current) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeDrag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: paneRef.current.getBoundingClientRect().width }
    document.body.classList.add('canvas-resizing')
    notifyTimelineViewportLayout('begin')
  }
  const moveResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDrag.current
    if (!drag || drag.pointerId !== event.pointerId) return
    setUserWidth(drag.startWidth + drag.startX - event.clientX)
    notifyTimelineViewportLayout('update')
  }
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeDrag.current?.pointerId !== event.pointerId) return
    resizeDrag.current = null
    document.body.classList.remove('canvas-resizing')
    commitWidth()
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }
  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 40 : 16
    const delta = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0
    if (!delta || !paneRef.current) return
    event.preventDefault()
    notifyTimelineViewportLayout('begin')
    setUserWidth(paneRef.current.getBoundingClientRect().width + delta)
    commitWidth()
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }
  const resetWidth = () => {
    notifyTimelineViewportLayout('begin')
    setUserWidth(null)
    window.localStorage.removeItem(canvasWidthStorageKey(workspaceKey))
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }

  return <aside ref={paneRef} className="canvas-pane" role="region" aria-label={t('canvas.title')}>
    <div
      className="canvas-pane-resize-handle"
      role="separator"
      aria-label={t('canvas.resize')}
      aria-orientation="vertical"
      tabIndex={0}
      title={t('canvas.resizeHint')}
      onPointerDown={beginResize}
      onPointerMove={moveResize}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onDoubleClick={resetWidth}
      onKeyDown={resizeWithKeyboard}
    />
    <header className="canvas-pane-header">
      <strong title={record?.path ?? name}>{t('canvas.title')} · {name}</strong>
      {canvases.length > 1 && <select value={name} aria-label={t('canvas.title')} onChange={event => { setName(event.target.value); setSelection(null); setSelecting(false) }}>
        {canvases.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select>}
      <div className="segmented canvas-pane-view-toggle" role="group" aria-label={t('canvas.view')}>
        <button type="button" className={view === 'preview' ? 'active' : ''} aria-pressed={view === 'preview'} onClick={() => setView('preview')}><Eye size={13} aria-hidden="true" />{t('canvas.preview')}</button>
        <button type="button" className={view === 'source' ? 'active' : ''} aria-pressed={view === 'source'} onClick={() => setView('source')}><FileCode2 size={13} aria-hidden="true" />{t('canvas.source')}</button>
      </div>
      <span className="canvas-pane-header-spacer" aria-hidden="true" />
      <button type="button" aria-pressed={selecting} disabled={!src || view !== 'preview'} title={t('canvas.selectElement')} onClick={toggleSelecting}><Crosshair size={14} /></button>
      <button type="button" title={t('canvas.reload')} onClick={() => { setPageError(null); setReloadToken(token => token + 1) }}><RefreshCw size={14} /></button>
      <button type="button" title={t('canvas.close')} aria-label={t('canvas.close')} onClick={onClose}><X size={14} /></button>
    </header>
    <div className="canvas-pane-body">
      {error
        ? <div className="canvas-pane-notice error">{error}</div>
        : !record
          ? <div className="canvas-pane-notice">{t('canvas.loading')}</div>
          : view === 'source'
            ? <pre className="canvas-pane-source">{record.source}</pre>
            : record.diagnostics || !record.javascript
              ? <div className="canvas-pane-notice error"><strong>{t('canvas.compileFailed')}</strong><pre>{record.diagnostics ?? ''}</pre></div>
              : <>
                {selecting && <div className="canvas-pane-selecting">{t('canvas.selecting')}</div>}
                <iframe ref={iframeRef} key={src ?? 'none'} src={src ?? undefined} sandbox="allow-scripts" title={`${t('canvas.title')} ${name}`} />
              </>}
      {pageError && view === 'preview' && <div className="canvas-pane-notice error"><strong>{t('canvas.pageError')}</strong><pre>{pageError}</pre></div>}
    </div>
    {selection && view === 'preview' && <footer className="canvas-pane-feedback">
      <textarea value={feedback} placeholder={t('canvas.feedbackPlaceholder')} onChange={event => setFeedback(event.target.value)} />
      <button type="button" className="primary-button" disabled={!feedback.trim()} onClick={addToChat}>{t('canvas.addToChat')}</button>
      <small>{selection.map(element => element.id ?? element.tag).join(', ')}</small>
    </footer>}
  </aside>
}
