import { AlertTriangle, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'

/** One line at the top of the window naming the chats whose agent is waiting for
 *  an answer or an approval. The open chat is left out: its shelf already shows
 *  the request. Hiding it lasts until a different set of chats is waiting. */
export function WaitingForYouBanner() {
  useLocale()
  const sessions = useAppStore(state => state.sessions)
  const selectedSessionId = useAppStore(state => state.selectedSessionId)
  const selectSession = useAppStore(state => state.selectSession)
  const [hidden, setHidden] = useState('')
  const waiting = useMemo(() => sessions.filter(session => (
    !session.archived
    && session.id !== selectedSessionId
    && Boolean(
      session.claude_needs_user_action || session.codex_needs_user_action
      || (session.claude_pending_interaction_count ?? 0) > 0
      || (session.codex_pending_interaction_count ?? 0) > 0,
    )
  )), [sessions, selectedSessionId])
  const key = waiting.map(session => session.id).sort().join(' ')
  if (!waiting.length || key === hidden) return null
  const [first] = waiting
  const text = waiting.length === 1
    ? t('waitingBanner.one', { provider: first.backend === 'codex' ? 'Codex' : 'Claude', title: first.title || first.id })
    : t('waitingBanner.many', { count: waiting.length, titles: waiting.map(session => session.title || session.id).join(', ') })
  return <div className="waiting-banner" role="status" aria-live="polite">
    <AlertTriangle size={15} />
    <button type="button" className="waiting-banner-open" onClick={() => void selectSession(first.id)}>{text}</button>
    <button type="button" className="icon-button" aria-label={t('waitingBanner.hide')} title={t('waitingBanner.hide')} onClick={() => setHidden(key)}><X size={15} /></button>
  </div>
}
