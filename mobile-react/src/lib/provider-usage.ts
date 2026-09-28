// Framework-free port of the desktop provider-usage snapshot contract
// (electron/src/shared/provider-usage.ts) plus the label/formatting logic from
// electron ProviderUsagePanel.tsx. Strings are plain English literals; no i18n.

export type UsageBackend = 'codex' | 'claude'

export interface ProviderUsageWindow {
  id: string
  label: string | null
  used_percent: number | null
  resets_at: number | null
  window_minutes: number | null
  observed_at: string
  status?: 'allowed' | 'allowed_warning' | 'rejected'
}

/** Provider-reported account allowance; separate from a chat's context or token count. */
export interface ProviderUsageSnapshot {
  backend: UsageBackend
  status: 'available' | 'unavailable'
  source: 'codex-account' | 'claude-events' | null
  observed_at: string | null
  account_kind: 'chatgpt' | 'subscription' | 'api_key' | 'custom' | 'unknown'
  windows: ProviderUsageWindow[]
  credits?: { balance: string | null; has_credits: boolean; unlimited: boolean }
  reason?: string
}

export function parseProviderUsage(value: unknown, backend: UsageBackend): ProviderUsageSnapshot {
  const data = value as ProviderUsageSnapshot | null
  if (!data || data.backend !== backend || !['available', 'unavailable'].includes(data.status)
    || !Array.isArray(data.windows)
    || !data.windows.every(window => window && typeof window.id === 'string'
      && (window.used_percent === null || (typeof window.used_percent === 'number' && Number.isFinite(window.used_percent)))
      && (window.resets_at === null || (typeof window.resets_at === 'number' && Number.isFinite(window.resets_at)))
      && typeof window.observed_at === 'string')
    || (data.credits !== undefined && (!data.credits || typeof data.credits.has_credits !== 'boolean'
      || typeof data.credits.unlimited !== 'boolean'
      || (data.credits.balance !== null && typeof data.credits.balance !== 'string')))) {
    throw new Error('Invalid provider usage response')
  }
  return data
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

export function formatUsagePercent(value: number): string {
  return String(Math.round(clampPercent(value)))
}

/** "12% used" for a single window or the overall summary. */
export function usedText(value: number): string {
  return `${formatUsagePercent(value)}% used`
}

export function windowLabel(window: ProviderUsageWindow, backend: UsageBackend): string {
  // Claude identifies its windows by id; Codex reports a duration plus a limit
  // name for buckets other than the default one.
  if (backend === 'claude') {
    const named = window.id === 'five_hour' ? 'Current session (5h)'
      : window.id === 'seven_day' ? 'Current week (all models)'
        : window.id === 'seven_day_opus' ? 'Current week (Opus)'
          : window.id === 'seven_day_sonnet' ? 'Current week (Sonnet)' : null
    if (named) return named
  }
  const period = window.window_minutes === 300 ? '5-hour limit'
    : window.window_minutes === 10080 ? 'Weekly limit'
      : window.window_minutes ? `${window.window_minutes} minutes` : null
  return window.label
    ? period && window.label !== period ? `${window.label} · ${period}` : window.label
    : period ?? 'Usage allowance'
}

/** "2d 3h" / "45m" until the reset; null once it has passed so the caller shows the absolute time. */
export function formatResetDelay(target: number, now = Date.now()): string | null {
  const minutes = Math.ceil((target - now) / 60_000)
  if (minutes <= 0) return null
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor(minutes % 1440 / 60)
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  }
  return `${minutes}m`
}

export function providerUsageReason(reason: string | undefined, backend: UsageBackend): string {
  switch (reason) {
    case 'custom_endpoint': return 'Usage is not reported for custom API endpoints.'
    case 'unsupported_transport': return 'Usage requires the Codex app-server transport.'
    case 'account_usage_unavailable': return 'This account type does not report usage.'
    case 'not_reported': case undefined:
      return backend === 'claude'
        ? 'Claude reports usage only while it runs; it appears after a Claude turn on this server.'
        : 'Codex has not reported usage yet.'
    default: return 'Usage is temporarily unavailable.'
  }
}
