import { CANVAS_HOST_MESSAGE_SOURCE, CANVAS_NAME_PATTERN, CANVAS_PAGE_MESSAGE_SOURCE, canvasPageURL, type CanvasHostTheme } from '@shared/canvas'
import { t } from '@shared/i18n'
import type { CanvasCommentMode, CanvasCommentThread, CanvasRecord, CanvasSummary, Session } from '@shared/types'
import { ChevronDown, ChevronUp, Crosshair, Eye, FileCode2, FileDown, MessageSquare, RefreshCw, Search, TableOfContents, X } from 'lucide-react'
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
import { interactiveClientCapabilities, useAppStore } from '../store/app-store'
import { CanvasCommentSubmit, CanvasCommentThreads, canvasAnchorLabel } from './CanvasCommentThreads'
import { CodeMirrorEditor } from './CodeMirrorEditor'
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
  // From the comment pins (canvas-protocol.ts COMMENT_PINS_SCRIPT).
  | { kind: 'comment-open'; id: string }
  | { kind: 'comment-anchors'; located: string[] }
  // From the floating table of contents (canvas-protocol.ts TOC_SCRIPT): whether the page has two or more headings to list.
  | { kind: 'toc'; available: boolean }

/** The in-iframe find reports over the same channel keyed on `type`, so it never collides with a runtime `kind`. */
interface FindResult { type: 'find-result'; total: number; active: number }

const CANVAS_SUFFIX = '.canvas.tsx'
const STATE_SAVE_DELAY_MS = 400
const CANVAS_WIDTH_KEY = 'agentsdock:canvas-width'
const CANVAS_TOC_KEY = 'agentsdock:canvas-toc'

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

const errorText = (caught: unknown) => caught instanceof Error ? caught.message : String(caught)
// The server's 409 text for a source save that lost to a newer revision (agentsdock_canvas.RevisionConflict).
const REVISION_CONFLICT = /changed since it was opened/

function appendDraft(sessionId: string, text: string): void {
  const store = useAppStore.getState()
  const current = store.drafts[sessionId] ?? ''
  store.setDraftForSession(sessionId, current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text)
}

export function CanvasPane({ session, target, onClose }: { session: Session; target: CanvasTarget; onClose: () => void }) {
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const canvasCapability = useAppStore(state => state.health?.capabilities?.canvas_v1)
  // Older servers keep the draft-based feedback and the read-only source.
  const commentsAvailable = canvasCapability?.comments === true
  const sourceEditable = canvasCapability?.source_edit === true
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
  const [threads, setThreads] = useState<CanvasCommentThread[]>([])
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [activeThread, setActiveThread] = useState<string | null>(null)
  const [located, setLocated] = useState<ReadonlySet<string> | null>(null)
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  /** Unsaved source edits and the revision they started from; null while the editor shows the saved source. */
  const [sourceDraft, setSourceDraft] = useState<{ text: string; baseRevision: number } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findResult, setFindResult] = useState<{ total: number; active: number }>({ total: 0, active: 0 })
  const findInputRef = useRef<HTMLInputElement>(null)
  // Read inside the page's `ready` handler (which resubscribes rarely) so a reload re-runs the open query.
  const findLive = useRef({ open: false, query: '' })
  const [tocVisible, setTocVisible] = useState(() => window.localStorage.getItem(CANVAS_TOC_KEY) !== 'hidden')
  const [tocAvailable, setTocAvailable] = useState(false)
  // Also read inside the `ready` handler, so a reloaded page gets the current choice.
  const tocLive = useRef(tocVisible)
  tocLive.current = tocVisible
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

  const loadComments = useCallback(async () => {
    if (!commentsAvailable) return
    try {
      setThreads((await window.agentsDock.canvas.comments(session.id, name)).threads)
    } catch (caught) {
      setCommentError(errorText(caught))
    }
  }, [commentsAvailable, name, session.id])
  useEffect(() => {
    setThreads([])
    setActiveThread(null)
    setLocated(null)
    void loadComments()
  }, [loadComments])

  // Pins for the open threads, numbered like the list; resent whenever the page (re)loads.
  const pins = useMemo(() => threads.flatMap((thread, index) => thread.status === 'open' ? [{
    id: thread.id, number: index + 1, canvasId: thread.anchor.canvas_id, tag: thread.anchor.tag, text: thread.anchor.text, label: canvasAnchorLabel(thread.anchor)
  }] : []), [threads])
  const pinsLive = useRef({ pins, active: activeThread })
  pinsLive.current = { pins, active: activeThread }

  // Turns and rewinds can change the canvases: re-list, reload when the open one has a new
  // revision (an agent edit, a comment's Edit), leave when it is gone, and refresh the threads.
  const revisionLive = useRef<number | null>(null)
  revisionLive.current = record?.revision ?? null
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ sessionId?: string }>).detail?.sessionId !== session.id) return
      void loadComments()
      void window.agentsDock.canvas.list(session.id)
        .then(list => list.canvases.find(canvas => canvas.name === name) ?? null)
        // Unknown → keep the pane; load() surfaces the error itself.
        .catch(() => undefined)
        .then(current => {
          if (current === null) onClose()
          else if (current === undefined || current.revision !== revisionLive.current) setReloadToken(token => token + 1)
        })
    }
    window.addEventListener('agentsdock:canvases-changed', changed)
    return () => window.removeEventListener('agentsdock:canvases-changed', changed)
  }, [loadComments, name, onClose, session.id])

  // Flush when the pane switches canvases and when it unmounts, so the last reported change is not dropped.
  useEffect(() => () => { void flushSave() }, [flushSave, name])

  const postToPage = useCallback((call: string, args: unknown[] = []) => {
    iframeRef.current?.contentWindow?.postMessage({ source: CANVAS_HOST_MESSAGE_SOURCE, call, args }, '*')
  }, [])

  const runFind = useCallback((query: string, options: { forward?: boolean; findNext?: boolean } = {}) => {
    postToPage('find', [query, { forward: options.forward ?? true, matchCase: false, findNext: options.findNext ?? false }])
  }, [postToPage])
  useEffect(() => { findLive.current = { open: findOpen, query: findQuery } }, [findOpen, findQuery])
  const openFind = useCallback(() => {
    setFindOpen(true)
    window.requestAnimationFrame(() => findInputRef.current?.select())
  }, [])
  const closeFind = useCallback(() => {
    setFindOpen(false)
    setFindResult({ total: 0, active: 0 })
    postToPage('clear-find')
  }, [postToPage])

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
      const asFind = message as unknown as FindResult
      if (asFind.type === 'find-result') {
        setFindResult({ total: asFind.total, active: asFind.active })
        return
      }
      switch (message.kind) {
        case 'ready':
          setPageError(null)
          // A fresh document lost any highlights: re-run the query the find bar still shows.
          if (findLive.current.open && findLive.current.query) runFind(findLive.current.query)
          postToPage('set-comments', [pinsLive.current.pins, pinsLive.current.active])
          postToPage('set-toc', [tocLive.current])
          break
        case 'toc':
          setTocAvailable(message.available)
          break
        case 'comment-open':
          setCommentsOpen(true)
          setActiveThread(message.id)
          break
        case 'comment-anchors':
          setLocated(new Set(message.located))
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
  }, [flushSave, handleAction, name, postToPage, runFind])

  useEffect(() => { postToPage('set-comments', [pins, activeThread]) }, [activeThread, pins, postToPage])

  // Follow the app's light/dark and color theme switches inside the frame.
  useEffect(() => {
    const observer = new MutationObserver(() => postToPage('updateTheme', [hostTheme()]))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin', 'data-color-theme'] })
    return () => observer.disconnect()
  }, [postToPage])

  const src = useMemo(() => {
    if (!profileId || !record || record.diagnostics || !record.javascript) return null
    return canvasPageURL({ profileId, profileGeneration, sessionId: session.id, name, theme: hostTheme(), reloadKey: `${record.revision}-${reloadToken}` })
  }, [name, profileGeneration, profileId, record, reloadToken, session.id])
  // Availability belongs to the page on screen, a new one per src and per return to the preview;
  // a page that never reports (an error page) leaves the toggle off.
  useEffect(() => { setTocAvailable(false) }, [src, view])

  const toggleSelecting = () => {
    const next = !selecting
    setSelecting(next)
    if (!next) setSelection(null)
    postToPage('setSelecting', [next])
  }

  const toggleToc = () => {
    const next = !tocVisible
    setTocVisible(next)
    saveLocalStorage(CANVAS_TOC_KEY, next ? 'shown' : 'hidden')
    postToPage('set-toc', [next])
  }

  const clearComposer = () => {
    setSelection(null)
    setFeedback('')
    postToPage('clearSelection')
  }

  const commentInput = (mode: CanvasCommentMode, body: string) => ({
    mode, body, revision: record?.revision ?? 0,
    // Same capabilities as a composer message, so the comment's turn uses the same transport.
    client_capabilities: interactiveClientCapabilities(session, useAppStore.getState().health)
  })

  /** Ask answers in the chat and leaves the canvas alone; Edit asks the agent to change it. */
  const submitComment = async (mode: CanvasCommentMode) => {
    if (!record || !selection?.length || !feedback.trim()) return
    const body = feedback.trim()
    if (!commentsAvailable) {
      const elements = selection.map(element => ({ id: element.id, tag: element.tag, text: element.text.slice(0, 400) }))
      appendDraft(session.id, [
        `Canvas ${record.path} (revision ${record.revision}) ${mode === 'ask' ? 'question about' : 'requested change to'} the selected elements:`,
        JSON.stringify(elements, null, 2),
        mode === 'ask' ? `Question (answer it without modifying the canvas): ${body}` : `Requested change: ${body}`
      ].join('\n'))
      clearComposer()
      return
    }
    const element = selection[0]
    setCommentBusy(true)
    setCommentError(null)
    try {
      const { thread } = await window.agentsDock.canvas.comment(session.id, name, {
        canvas_id: element.id, tag: element.tag, text: element.text.slice(0, 400), html: element.html.slice(0, 2000)
      }, commentInput(mode, body))
      setThreads(current => [...current, thread])
      setActiveThread(thread.id)
      setCommentsOpen(true)
      clearComposer()
    } catch (caught) {
      setCommentError(errorText(caught))
    } finally {
      setCommentBusy(false)
    }
  }

  const replaceThread = (thread: CanvasCommentThread) => setThreads(current => current.map(item => item.id === thread.id ? thread : item))
  const replyToThread = async (thread: CanvasCommentThread, mode: CanvasCommentMode, body: string): Promise<boolean> => {
    setCommentError(null)
    try {
      replaceThread((await window.agentsDock.canvas.reply(session.id, name, thread.id, commentInput(mode, body))).thread)
      return true
    } catch (caught) {
      setCommentError(errorText(caught))
      return false
    }
  }
  const setThreadStatus = (thread: CanvasCommentThread, status: CanvasCommentThread['status']) => {
    void window.agentsDock.canvas.setCommentStatus(session.id, name, thread.id, status)
      .then(result => replaceThread(result.thread), caught => setCommentError(errorText(caught)))
  }
  const deleteThread = (thread: CanvasCommentThread) => {
    if (!window.confirm(t('canvas.deleteCommentConfirm'))) return
    void window.agentsDock.canvas.deleteComment(session.id, name, thread.id)
      .then(() => setThreads(current => current.filter(item => item.id !== thread.id)), caught => setCommentError(errorText(caught)))
  }
  const activateThread = (id: string) => {
    setActiveThread(id)
    setView('preview')
    postToPage('focus-comment', [id])
  }

  const discardUnsavedSource = () => !sourceDraft || window.confirm(t('canvas.discardSourceConfirm'))
  const saveSource = async (overwrite = false): Promise<void> => {
    if (!sourceDraft || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      // Overwriting means saving over whatever revision is current now, after the user confirmed.
      const base = overwrite ? (await window.agentsDock.canvas.get(session.id, name)).revision : sourceDraft.baseRevision
      const next = await window.agentsDock.canvas.putSource(session.id, name, sourceDraft.text, base)
      setRecord(next)
      stateRef.current = next.state ?? {}
      setSourceDraft(null)
    } catch (caught) {
      const message = errorText(caught)
      if (!overwrite && REVISION_CONFLICT.test(message) && window.confirm(t('canvas.overwriteConfirm'))) {
        setSaving(false)
        return saveSource(true)
      }
      setSaveError(message)
    } finally {
      setSaving(false)
    }
  }
  const fixWithAgent = () => {
    if (!record?.diagnostics) return
    void useAppStore.getState().sendPromptForSession(session.id, [
      `The canvas ${record.path} fails to compile:`,
      '',
      record.diagnostics,
      '',
      'Fix the canvas source so it compiles, then run the canvas check.'
    ].join('\n'), false, { consumeComposer: false })
  }

  // The chosen width lives on the conversation pane because the chat column beside the Canvas reads it too;
  // CanvasPane.css clamps it so neither side collapses on a smaller window.
  const paneRef = useRef<HTMLElement>(null)
  const resizeDrag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null)
  useLayoutEffect(() => {
    const host = paneRef.current?.parentElement
    if (!host) return
    const saved = Number(window.localStorage.getItem(CANVAS_WIDTH_KEY))
    if (saved > 0) host.style.setProperty('--canvas-pane-user-width', `${saved}px`)
    return () => {
      host.style.removeProperty('--canvas-pane-user-width')
      document.body.classList.remove('canvas-resizing')
    }
  }, [])

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
    saveLocalStorage(CANVAS_WIDTH_KEY, String(width))
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
    window.localStorage.removeItem(CANVAS_WIDTH_KEY)
    window.requestAnimationFrame(() => notifyTimelineViewportLayout('end'))
  }

  const paneKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f' && view === 'preview' && src) {
      event.preventDefault()
      openFind()
    } else if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's' && view === 'source' && sourceDraft) {
      event.preventDefault()
      void saveSource()
    }
  }

  return <aside ref={paneRef} className="canvas-pane" role="region" aria-label={t('canvas.title')} onKeyDown={paneKeyDown}>
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
      {canvases.length > 1 && <select value={name} aria-label={t('canvas.title')} onChange={event => {
        if (!discardUnsavedSource()) return
        setSourceDraft(null)
        setName(event.target.value); setSelection(null); setSelecting(false)
      }}>
        {canvases.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select>}
      <div className="segmented canvas-pane-view-toggle" role="group" aria-label={t('canvas.view')}>
        <button type="button" className={view === 'preview' ? 'active' : ''} aria-pressed={view === 'preview'} onClick={() => setView('preview')}><Eye size={13} aria-hidden="true" />{t('canvas.preview')}</button>
        <button type="button" className={view === 'source' ? 'active' : ''} aria-pressed={view === 'source'} onClick={() => setView('source')}><FileCode2 size={13} aria-hidden="true" />{t('canvas.source')}</button>
      </div>
      <button type="button" aria-pressed={findOpen} disabled={!src || view !== 'preview'} title={t('canvas.find')} aria-label={t('canvas.find')} onClick={() => (findOpen ? closeFind() : openFind())}><Search size={14} /></button>
      <button type="button" aria-pressed={tocVisible} disabled={!src || view !== 'preview' || !tocAvailable} title={t('canvas.toc')} aria-label={t('canvas.toc')} onClick={toggleToc}><TableOfContents size={14} /></button>
      <span className="canvas-pane-header-spacer" aria-hidden="true" />
      <button type="button" aria-pressed={selecting} disabled={!src || view !== 'preview'} title={t(commentsAvailable ? 'canvas.commentOnElement' : 'canvas.selectElement')} onClick={toggleSelecting}><Crosshair size={14} /></button>
      {commentsAvailable && <button type="button" aria-pressed={commentsOpen} title={t('canvas.comments')} aria-label={t('canvas.comments')} onClick={() => setCommentsOpen(value => !value)}>
        <MessageSquare size={14} />{pins.length > 0 && <span className="canvas-pane-comment-count">{pins.length}</span>}
      </button>}
      <button type="button" title={t('canvas.reload')} onClick={() => { setPageError(null); setReloadToken(token => token + 1) }}><RefreshCw size={14} /></button>
      <button type="button" disabled={!src} title={t('canvas.exportHtml')} aria-label={t('canvas.exportHtml')} onClick={() => {
        void window.agentsDock.canvas.exportHtml(session.id, name, hostTheme()).catch(error => useAppStore.getState().setError(errorText(error)))
      }}><FileDown size={14} /></button>
      <button type="button" title={t('canvas.close')} aria-label={t('canvas.close')} onClick={() => { if (discardUnsavedSource()) onClose() }}><X size={14} /></button>
    </header>
    <div className="canvas-pane-body">
      {findOpen && view === 'preview' && <div className="canvas-pane-find" role="search">
        <Search size={13} aria-hidden="true" />
        <input
          ref={findInputRef}
          type="text"
          aria-label={t('canvas.find')}
          placeholder={t('canvas.findPlaceholder')}
          value={findQuery}
          onChange={event => { setFindQuery(event.target.value); runFind(event.target.value) }}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); runFind(findQuery, { findNext: true, forward: !event.shiftKey }) }
            else if (event.key === 'Escape') { event.preventDefault(); closeFind() }
          }}
        />
        <span className="canvas-pane-find-count">{findQuery ? t('canvas.findCount', { active: findResult.active, total: findResult.total }) : ''}</span>
        <button type="button" title={t('canvas.findPrev')} aria-label={t('canvas.findPrev')} disabled={findResult.total === 0} onClick={() => runFind(findQuery, { findNext: true, forward: false })}><ChevronUp size={14} /></button>
        <button type="button" title={t('canvas.findNext')} aria-label={t('canvas.findNext')} disabled={findResult.total === 0} onClick={() => runFind(findQuery, { findNext: true, forward: true })}><ChevronDown size={14} /></button>
        <button type="button" title={t('canvas.close')} aria-label={t('canvas.close')} onClick={closeFind}><X size={14} /></button>
      </div>}
      {error
        ? <div className="canvas-pane-notice error">{error}</div>
        : !record
          ? <div className="canvas-pane-notice">{t('canvas.loading')}</div>
          : view === 'source'
            ? sourceEditable
              ? <div className="canvas-pane-editor">
                <div className="canvas-pane-editor-bar">
                  <span title={record.path}>{sourceDraft ? t('canvas.sourceUnsaved') : t('canvas.sourceSaved')}</span>
                  {sourceDraft && sourceDraft.baseRevision !== record.revision && <span className="canvas-pane-editor-stale">{t('canvas.sourceChangedMeanwhile')}</span>}
                  <button type="button" className="quiet-button" disabled={!sourceDraft || saving} onClick={() => { setSourceDraft(null); setSaveError(null) }}>{t('canvas.discard')}</button>
                  <button type="button" className="primary-button" disabled={!sourceDraft || saving} onClick={() => void saveSource()}>{saving ? t('canvas.saving') : t('canvas.save')}</button>
                </div>
                {saveError && <div className="canvas-pane-notice error">{saveError}</div>}
                <CodeMirrorEditor
                  path={record.path}
                  value={sourceDraft?.text ?? record.source}
                  readOnly={saving}
                  ariaLabel={t('canvas.sourceEditor')}
                  onChange={value => setSourceDraft(current => value === record.source ? null : { text: value, baseRevision: current?.baseRevision ?? record.revision })}
                />
              </div>
              : <pre className="canvas-pane-source">{record.source}</pre>
            : record.diagnostics || !record.javascript
              ? <div className="canvas-pane-notice error">
                <strong>{t('canvas.compileFailed')}</strong><pre>{record.diagnostics ?? ''}</pre>
                {record.diagnostics && <button type="button" className="quiet-button canvas-pane-fix" onClick={fixWithAgent}>{t('canvas.fixWithAgent')}</button>}
              </div>
              : <>
                {selecting && <div className="canvas-pane-selecting">{t('canvas.selecting')}</div>}
                <iframe ref={iframeRef} key={src ?? 'none'} src={src ?? undefined} sandbox="allow-scripts" title={`${t('canvas.title')} ${name}`} />
              </>}
      {pageError && view === 'preview' && <div className="canvas-pane-notice error"><strong>{t('canvas.pageError')}</strong><pre>{pageError}</pre></div>}
    </div>
    {commentsAvailable && commentsOpen && <CanvasCommentThreads
      sessionId={session.id}
      threads={threads}
      activeId={activeThread}
      located={located}
      onActivate={activateThread}
      onReply={replyToThread}
      onStatus={setThreadStatus}
      onDelete={deleteThread}
    />}
    {commentError && <div className="canvas-pane-notice error" role="alert">{commentError}</div>}
    {selection && view === 'preview' && <footer className="canvas-pane-feedback">
      <textarea value={feedback} placeholder={t('canvas.commentPlaceholder')} onChange={event => setFeedback(event.target.value)} />
      <CanvasCommentSubmit disabled={!feedback.trim() || commentBusy} onSubmit={mode => void submitComment(mode)} />
      <small>{commentsAvailable ? canvasAnchorLabel({ canvas_id: selection[0].id, tag: selection[0].tag, text: selection[0].text }) : selection.map(element => element.id ?? element.tag).join(', ')}</small>
    </footer>}
  </aside>
}
