import { t } from '@shared/i18n'
import { Skull } from 'lucide-react'
import { useState } from 'react'
import './CodexWriterRelease.css'

/** Codex's refusal to share a thread another process writes, and the server's wording of it after its retries. */
export const ACTIVE_WRITER_ERROR = /already has an active writer|another codex process still holds this chat's thread/i

export function isActiveWriterError(text: string | null | undefined): boolean {
  return Boolean(text && ACTIVE_WRITER_ERROR.test(text))
}

/**
 * One-click recovery for "thread … already has an active writer": asks the
 * server to unsubscribe the thread and kill foreign codex app-server processes,
 * then tells the user to resend.
 */
export function CodexWriterRelease({ sessionId, compact = false }: { sessionId: string; compact?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const release = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await window.agentsDock.codex.killWriters(sessionId)
      const others = result.other_holders ?? []
      // The server reports writers it could not end separately from what it
      // ended, so both can be non-empty at once; a resend still fails while one
      // remains, so always report it.
      const outcome = result.killed.length
        ? t('codex.killWriters.done', { count: String(result.killed.length) })
        : result.restarted_app_server
          ? t('codex.killWriters.restarted')
          : result.busy_sessions?.length
            ? t('codex.killWriters.busy', { count: String(result.busy_sessions.length) })
            : others.length ? '' : t('codex.killWriters.none')
      const otherHolders = others.length
        ? t('codex.killWriters.otherHolders', { owners: [...new Set(others.map(holder => holder.owner))].join(', ') })
        : ''
      setNotice([outcome, otherHolders].filter(Boolean).join(' '))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return <span className={`codex-writer-release${compact ? ' compact' : ''}`}>
    <button type="button" className="quiet-button danger" disabled={busy} title={t('codex.killWriters.hint')} onClick={() => void release()}>
      <Skull size={12} />{' '}{busy ? t('codex.killWriters.working') : t('codex.killWriters.action')}
    </button>
    {notice && <small role="status">{notice}</small>}
  </span>
}
