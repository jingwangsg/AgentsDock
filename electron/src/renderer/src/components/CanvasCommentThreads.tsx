import { t } from '@shared/i18n'
import type { CanvasCommentAnchor, CanvasCommentMessage, CanvasCommentMode, CanvasCommentThread } from '@shared/types'
import { Check, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { MarkdownContent } from './MarkdownContent'

/**
 * "loss-table · 1.92" or `<td> 1.92` — how a thread names the element it is about. The id is
 * the nearest data-canvas-id, often a whole section, so the element's own text follows it.
 * Same format as the server's display prompt (agentsdock_canvas.comment_prompt).
 */
export function canvasAnchorLabel(anchor: Pick<CanvasCommentAnchor, 'canvas_id' | 'tag' | 'text'>): string {
  const text = anchor.text.replace(/\s+/g, ' ').trim().slice(0, 40)
  if (anchor.canvas_id) return text ? `${anchor.canvas_id} · ${text}` : anchor.canvas_id
  return `<${anchor.tag}> ${text}`.trim()
}

/** Ask/Edit submit pair shared by the new-comment footer and each thread's reply box. */
export function CanvasCommentSubmit({ disabled, onSubmit }: { disabled: boolean; onSubmit: (mode: CanvasCommentMode) => void }) {
  return <div className="canvas-comment-submit">
    <button type="button" className="quiet-button" disabled={disabled} title={t('canvas.askHint')} onClick={() => onSubmit('ask')}>{t('canvas.modeAsk')}</button>
    <button type="button" className="primary-button" disabled={disabled} title={t('canvas.editHint')} onClick={() => onSubmit('edit')}>{t('canvas.modeEdit')}</button>
  </div>
}

function Reply({ sessionId, message }: { sessionId: string; message: CanvasCommentMessage }) {
  const reply = message.reply
  if (!reply || reply.status === 'queued') return <p className="canvas-comment-status">{t('canvas.replyQueued')}</p>
  if (reply.status === 'running') return <p className="canvas-comment-status">{t('canvas.replyRunning')}</p>
  if (reply.status === 'cancelled') return <p className="canvas-comment-status">{t('canvas.replyCancelled')}</p>
  return <div className={`canvas-comment-reply ${reply.status}`}>
    {reply.status !== 'done' && <p className="canvas-comment-status">{t(reply.status === 'stopped' ? 'canvas.replyStopped' : 'canvas.replyFailed')}</p>}
    {reply.text ? <MarkdownContent text={reply.text} sessionId={sessionId} compact fold={false} /> : null}
  </div>
}

export function CanvasCommentThreads({ sessionId, threads, activeId, located, onActivate, onReply, onStatus, onDelete }: {
  sessionId: string
  threads: CanvasCommentThread[]
  activeId: string | null
  /** Threads whose element exists in the rendered revision; null until the page reported. */
  located: ReadonlySet<string> | null
  onActivate: (id: string) => void
  onReply: (thread: CanvasCommentThread, mode: CanvasCommentMode, body: string) => Promise<boolean>
  onStatus: (thread: CanvasCommentThread, status: CanvasCommentThread['status']) => void
  onDelete: (thread: CanvasCommentThread) => void
}) {
  // Per thread, so switching threads neither carries nor drops a half-written reply.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [showResolved, setShowResolved] = useState(false)
  // A new comment or a clicked pin makes a thread active; bring it into view.
  const listRef = useRef<HTMLElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('.canvas-comment-thread.active')?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId, threads])
  // Numbers follow creation order and match the pins, so a resolved thread keeps its number.
  const numbered = threads.map((thread, index) => ({ thread, number: index + 1 }))
  const open = numbered.filter(item => item.thread.status === 'open')
  const resolved = numbered.filter(item => item.thread.status === 'resolved')

  const renderThread = ({ thread, number }: { thread: CanvasCommentThread; number: number }) => {
    const active = thread.id === activeId
    return <article key={thread.id} className={`canvas-comment-thread${active ? ' active' : ''}${thread.status === 'resolved' ? ' resolved' : ''}`}>
      <header>
        <button type="button" className="canvas-comment-anchor" onClick={() => onActivate(thread.id)} title={t('canvas.showElement')}>
          <span className="canvas-comment-number">{number}</span>
          <span className="canvas-comment-label">{canvasAnchorLabel(thread.anchor)}</span>
        </button>
        {located && !located.has(thread.id) && <span className="canvas-comment-detached">{t('canvas.elementGone')}</span>}
        {thread.status === 'open'
          ? <button type="button" className="icon-button" title={t('canvas.resolve')} aria-label={t('canvas.resolve')} onClick={() => onStatus(thread, 'resolved')}><Check size={14} /></button>
          : <button type="button" className="icon-button" title={t('canvas.reopen')} aria-label={t('canvas.reopen')} onClick={() => onStatus(thread, 'open')}><RotateCcw size={14} /></button>}
        <button type="button" className="icon-button" title={t('canvas.deleteComment')} aria-label={t('canvas.deleteComment')} onClick={() => onDelete(thread)}><Trash2 size={14} /></button>
      </header>
      {thread.messages.map(message => <div key={message.id} className="canvas-comment-exchange">
        <div className="canvas-comment-message">
          <span className={`canvas-comment-mode ${message.mode}`}>{t(message.mode === 'ask' ? 'canvas.modeAsk' : 'canvas.modeEdit')}</span>
          <p>{message.body}</p>
        </div>
        <Reply sessionId={sessionId} message={message} />
      </div>)}
      {active && <div className="canvas-comment-reply-box">
        <textarea value={drafts[thread.id] ?? ''} placeholder={t('canvas.replyPlaceholder')} onChange={event => setDrafts(current => ({ ...current, [thread.id]: event.target.value }))} />
        <CanvasCommentSubmit disabled={!(drafts[thread.id] ?? '').trim() || sending} onSubmit={mode => {
          setSending(true)
          void onReply(thread, mode, (drafts[thread.id] ?? '').trim())
            .then(sent => { if (sent) setDrafts(current => ({ ...current, [thread.id]: '' })) })
            .finally(() => setSending(false))
        }} />
      </div>}
    </article>
  }

  return <section ref={listRef} className="canvas-pane-comments" aria-label={t('canvas.comments')}>
    {!threads.length && <p className="canvas-comment-status">{t('canvas.noComments')}</p>}
    {open.map(renderThread)}
    {resolved.length > 0 && <button type="button" className="canvas-comment-resolved-toggle" aria-expanded={showResolved} onClick={() => setShowResolved(value => !value)}>
      {t('canvas.resolvedCount', { count: resolved.length })}
    </button>}
    {showResolved && resolved.map(renderThread)}
  </section>
}
