import { t } from '@shared/i18n'
import * as Popover from '@radix-ui/react-popover'
import { LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BackgroundActivityItem, Session } from '@shared/types'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'

// Codex has no push when a background terminal exits, and a Claude task starts mid-turn without one; listed items, and a running Claude turn, are re-checked on this interval.
const RECHECK_MS = 15_000

/** Header chip for what keeps running for a chat outside its turn: Codex background terminals, or the agents and shells Claude still tracks. */
export function BackgroundActivityButton({ session }: { session: Session }) {
  useLocale()
  const isClaude = session.backend === 'claude'
  const available = useAppStore(state => (session.backend === 'codex' || isClaude) && state.health?.capabilities?.background_activity_v1?.available === true)
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  const scope = useMemo(() => profileId ? { profileId, profileGeneration, serverIdentity } : null, [profileId, profileGeneration, serverIdentity])
  const running = useAppStore(state => state.activeSessionIds.has(session.id))
  const [items, setItems] = useState<BackgroundActivityItem[]>([])
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)

  const load = useCallback(() => {
    const api = window.agentsDock.backgroundActivity
    if (!available || !scope || !api) return
    const current = ++request.current
    void api.list(scope, session.id)
      .then(next => { if (request.current === current) setItems(next) })
      .catch(() => undefined)
  }, [available, scope, session.id])

  useEffect(() => setItems([]), [load])
  // `running`: a Codex background terminal starts during a turn and is listed from its end.
  useEffect(load, [load, running])
  // A Claude task starts mid-turn and keeps the turn open, so a Claude turn is re-checked too.
  useEffect(() => {
    if (!items.length && !(isClaude && running)) return
    const timer = window.setInterval(load, RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [items, isClaude, running, load])

  const stop = async (item: BackgroundActivityItem) => {
    const api = window.agentsDock.backgroundActivity
    if (confirmId !== item.id) { setConfirmId(item.id); return }
    if (!scope || !api) return
    setStopping(item.id)
    setError(null)
    if (!await api.stop(scope, session.id, item.id).catch(() => false)) setError(t('backgroundActivity.stopFailed'))
    setStopping(null)
    setConfirmId(null)
    load()
  }

  if (!items.length) return null
  const title = t(isClaude ? 'backgroundActivity.tasksTitle' : 'backgroundActivity.title')
  const label = t('backgroundActivity.count', { count: items.length })
  return <Popover.Root onOpenChange={open => { if (!open) { setConfirmId(null); setError(null) } }}>
    <Popover.Trigger asChild>
      <button type="button" className="codex-status-button" title={title} aria-label={`${title}: ${label}`}>
        <LoaderCircle className="spin" size={11} aria-hidden="true" /><b>{label}</b>
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="menu-content background-activity-menu" side="bottom" align="end" sideOffset={8} collisionPadding={12}>
        <div className="menu-label">{title}</div>
        {items.map(item => <div className="background-activity-item" key={item.id}>
          <code title={item.command}>{item.command || item.id}</code>
          {/* The Claude SDK has no call that ends one task. */}
          {!isClaude && <button type="button" className={confirmId === item.id ? 'danger-button compact' : 'quiet-button'} disabled={stopping !== null}
            aria-label={t('backgroundActivity.stopLabel', { title: item.command || item.id })} onClick={() => void stop(item)}>
            {stopping === item.id ? <LoaderCircle className="spin" size={12} /> : t(confirmId === item.id ? 'backgroundActivity.confirmStop' : 'backgroundActivity.stop')}
          </button>}
        </div>)}
        {error && <p className="background-activity-error" role="alert">{error}</p>}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}
