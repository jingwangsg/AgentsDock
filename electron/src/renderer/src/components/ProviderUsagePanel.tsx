import { ChevronRight, Gauge, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getLocale, t } from '@shared/i18n'
import type { ProviderUsageSnapshot, ProviderUsageWindow, UsageBackend } from '@shared/provider-usage'
import type { Session } from '@shared/types'
import { useLocale } from '../lib/i18n'
import { useAppStore } from '../store/app-store'
import './ProviderUsagePanel.css'

interface UsageState {
  key: string
  value: ProviderUsageSnapshot | null
  refreshing: boolean
  failed: boolean
}

export interface ProviderUsageView {
  backend: UsageBackend | null
  /** Identifies the server + session + provider selection the usage belongs to. */
  scopeKey: string
  /** False for shared chats, unsupported backends, and servers without the provider_usage capability. */
  supported: boolean
  connected: boolean
  usage: ProviderUsageSnapshot | null
  refreshing: boolean
  failed: boolean
  refresh(force?: boolean): void
}

/** Loads the provider account usage for a chat and refetches when the server reports a change. */
export function useProviderUsage(session: Session): ProviderUsageView {
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const connected = useAppStore(state => state.connected)
  const serverIdentity = useAppStore(state => state.health?.server_identity)
  const serverInstance = useAppStore(state => state.health?.server_instance_id)
  const available = useAppStore(state => state.health?.capabilities?.provider_usage?.available === true)
  const backend = session.backend === 'codex' || session.backend === 'claude' ? session.backend : null
  const key = JSON.stringify([profileId, profileGeneration, serverIdentity, serverInstance, session.id, backend, session.codex_provider])
  const [state, setState] = useState<UsageState>({ key: '', value: null, refreshing: false, failed: false })
  const refreshRef = useRef<(force?: boolean) => void>(() => undefined)

  useEffect(() => {
    const api = window.agentsDock.runtime?.usage
    if (!backend || !profileId || !available || !connected || window.agentsDock.sharedChat || !api) return
    const scope = { profileId, profileGeneration, serverIdentity }
    let disposed = false
    let pending = false
    let requested = false
    let forceNext = false
    const read = async (force = false): Promise<void> => {
      if (pending) { requested = true; forceNext ||= force; return }
      pending = true
      setState(previous => ({ key, value: previous.key === key ? previous.value : null, refreshing: true, failed: false }))
      try {
        const value = await api(scope, backend, session.id, force)
        if (!disposed) setState({ key, value, refreshing: false, failed: false })
      } catch {
        if (!disposed) setState(previous => previous.key === key ? { ...previous, refreshing: false, failed: true } : previous)
      } finally {
        pending = false
        if (!disposed && requested) {
          requested = false
          const next = forceNext
          forceNext = false
          void read(next)
        }
      }
    }
    const refreshNow = (force = true) => { void read(force) }
    refreshRef.current = refreshNow
    const unsubscribe = window.agentsDock.events.on('provider-usage:changed', event => {
      if (event.profileId !== profileId || event.profileGeneration !== profileGeneration
        || event.sessionId !== session.id || event.backend !== backend) return
      void read()
    })
    void read()
    return () => {
      disposed = true
      unsubscribe()
      if (refreshRef.current === refreshNow) refreshRef.current = () => undefined
    }
  }, [key, profileId, profileGeneration, serverIdentity, session.id, backend, available, connected])

  const refresh = useCallback((force = true) => refreshRef.current(force), [])
  const current = state.key === key
  return {
    backend, scopeKey: key, connected,
    supported: !window.agentsDock.sharedChat && available && backend !== null,
    usage: current ? state.value : null,
    refreshing: current && state.refreshing,
    failed: current && state.failed,
    refresh
  }
}

/** Collapsible "Usage" section for the Codex and Claude thread-controls dialogs. */
export function ProviderUsagePanel({ session }: { session: Session }) {
  useLocale()
  const view = useProviderUsage(session)
  const [open, setOpen] = useState(true)
  if (!view.supported || !view.backend) return null
  const { usage } = view
  const usedValues = usage?.status === 'available'
    ? usage.windows.flatMap(window => window.used_percent === null ? [] : [Math.max(0, Math.min(100, window.used_percent))]) : []
  const summary = usage === null
    ? t(view.refreshing ? 'providerUsage.loading' : view.failed ? 'providerUsage.loadFailed' : 'providerUsage.unavailable')
    : usage.status !== 'available' ? t('providerUsage.unavailable')
      : usage.windows.some(window => window.status === 'rejected') ? t('providerUsage.limitReached')
        : usedValues.length ? t('providerUsage.used', { percent: formatUsagePercent(Math.max(...usedValues)) }) : t('providerUsage.notReported')
  return <section className="codex-control-section provider-usage-section">
    <button type="button" className="codex-section-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Gauge size={15} /><span><strong>{t('providerUsage.section')}</strong><small>{summary}</small></span><ChevronRight className={open ? 'open' : ''} size={14} />
    </button>
    {open && <ProviderUsageBody view={view} backend={view.backend} />}
  </section>
}

/** Usage windows, credits and status lines; shared by the thread-controls section and the composer popover. */
export function ProviderUsageBody({ view, backend }: { view: ProviderUsageView; backend: UsageBackend }) {
  useLocale()
  const { usage, connected, refreshing, failed, refresh } = view
  return <div className="provider-usage-body">
    {usage?.status === 'available' && usage.windows.map(window => {
      const label = windowLabel(window, backend)
      const used = window.used_percent === null ? null : Math.max(0, Math.min(100, window.used_percent))
      const resetsAt = window.resets_at === null ? null : window.resets_at * 1000
      const delay = resetsAt === null ? null : formatDelay(resetsAt)
      return <div key={window.id} className={`provider-usage-window${window.status === 'rejected' ? ' rejected' : window.status === 'allowed_warning' ? ' warning' : ''}`}>
        <div className="provider-usage-row"><span>{label}</span><strong>{used === null
          ? window.status === 'rejected' ? t('providerUsage.limitReached') : t('providerUsage.notReported')
          : t('providerUsage.used', { percent: formatUsagePercent(used) })}</strong></div>
        {used !== null && <progress max={100} value={used} aria-label={t('providerUsage.windowUsed', { window: label })} />}
        {resetsAt !== null && <p title={formatTime(resetsAt)}>{delay === null
          ? t('providerUsage.resets', { time: formatTime(resetsAt) }) : t('providerUsage.resetsIn', { time: delay })}</p>}
      </div>
    })}
    {usage?.credits && <div className="provider-usage-row provider-usage-credits"><span>{t('providerUsage.credits')}</span><strong>{
      usage.credits.unlimited ? t('providerUsage.unlimited') : usage.credits.balance !== null ? usage.credits.balance
        : usage.credits.has_credits ? t('providerUsage.available') : t('providerUsage.none')
    }</strong></div>}
    {usage?.status === 'unavailable' && <p className="provider-usage-reason" role="status">{unavailableReason(usage.reason, backend)}</p>}
    <footer>
      {!usage && refreshing && <p role="status">{t('providerUsage.loading')}</p>}
      {!connected && <p role="status">{t('providerUsage.offline')}</p>}
      {failed && <p role="status">{t(usage ? 'providerUsage.refreshFailed' : 'providerUsage.loadFailed')}</p>}
      {usage?.observed_at && <p>{t('providerUsage.reported', { time: formatTime(Date.parse(usage.observed_at)) })}</p>}
      {usage?.source === 'claude-events' && <p>{t('providerUsage.claudeObserved')}</p>}
      <button type="button" className="quiet-button" disabled={!connected || refreshing} onClick={() => refresh()}>
        <RefreshCw size={13} className={refreshing ? 'spin' : undefined} />{t('providerUsage.refresh')}
      </button>
    </footer>
  </div>
}

export function formatUsagePercent(value: number): string {
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 0 }).format(value)
}

function formatTime(value: number): string {
  return Number.isFinite(value) ? new Date(value).toLocaleString(getLocale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'
}

/** "2d 3h" / "45m" until `target`; null once the reset time has passed so the caller shows the absolute time instead. */
function formatDelay(target: number): string | null {
  const minutes = Math.ceil((target - Date.now()) / 60_000)
  if (minutes <= 0) return null
  const parts: [number, 'day' | 'hour' | 'minute'][] = minutes >= 1440
    ? [[Math.floor(minutes / 1440), 'day'], [Math.floor(minutes % 1440 / 60), 'hour']]
    : minutes >= 60 ? [[Math.floor(minutes / 60), 'hour'], [minutes % 60, 'minute']] : [[minutes, 'minute']]
  return parts.filter(([count]) => count > 0)
    .map(([count, unit]) => new Intl.NumberFormat(getLocale(), { style: 'unit', unit, unitDisplay: 'narrow' }).format(count)).join(' ')
}

function windowLabel(window: ProviderUsageWindow, backend: UsageBackend): string {
  // Claude identifies its windows by id; Codex reports a duration plus a limit
  // name for buckets other than the default one.
  if (backend === 'claude') {
    const named = window.id === 'five_hour' ? t('providerUsage.claudeSession')
      : window.id === 'seven_day' ? t('providerUsage.claudeWeek')
        : window.id === 'seven_day_opus' ? t('providerUsage.claudeWeekOpus')
          : window.id === 'seven_day_sonnet' ? t('providerUsage.claudeWeekSonnet') : null
    if (named) return named
  }
  const period = window.window_minutes === 300 ? t('providerUsage.fiveHour')
    : window.window_minutes === 10080 ? t('providerUsage.weekly')
      : window.window_minutes ? t('providerUsage.minutes', { count: window.window_minutes }) : null
  return window.label ? period && window.label !== period ? `${window.label} · ${period}` : window.label
    : period ?? t('providerUsage.allowance')
}

function unavailableReason(reason: string | undefined, backend: UsageBackend): string {
  switch (reason) {
    case 'custom_endpoint': return t('providerUsage.reason.customEndpoint')
    case 'unsupported_transport': return t('providerUsage.reason.unsupportedTransport')
    case 'account_usage_unavailable': return t('providerUsage.reason.accountType')
    case 'not_reported': case undefined:
      return t(backend === 'claude' ? 'providerUsage.reason.notReportedClaude' : 'providerUsage.reason.notReported')
    default: return t('providerUsage.reason.temporary')
  }
}
