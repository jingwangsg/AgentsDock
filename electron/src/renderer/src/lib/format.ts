import type { Backend, CodexProvider, RuntimeCatalog, Session } from '@shared/types'
import { getLocale, t, type Locale } from '@shared/i18n'
import { runtimeBackendCatalogFor, runtimeEffortOptions } from '@shared/runtime-catalog'

export function backendLabel(backend: Backend, codexProvider?: CodexProvider): string {
  if (backend === 'codex' && codexProvider === 'custom') return t('codexProvider.label')
  if (backend === 'codex') return 'Codex'
  if (backend === 'cursor') return 'Cursor'
  if (backend === 'opencode') return 'OpenCode'
  return 'Claude'
}

export function formatTime(value?: string | null, locale: Locale = getLocale()): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const now = new Date()
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date)
  if (date.toDateString() === now.toDateString()) return t('editor.timeToday', { time }, locale)
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return t('editor.timeYesterday', { time }, locale)
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes; let index = 0
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1 }
  return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/** "now", "3m", "2h", "5d": the compact age Zed shows next to a thread. */
export function shortRelativeTime(iso?: string | null, now = Date.now()): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** Last two path segments, "project / dir", the way Zed labels a worktree. */
export function workingDirectoryTail(cwd?: string | null): string {
  const parts = (cwd || '').split('/').filter(Boolean)
  return parts.slice(-2).join(' / ')
}

export function formatDuration(seconds?: number | null): string {
  if (!seconds || seconds < 0) return t('editor.durationSeconds', { seconds: 0 })
  if (seconds < 60) return t('editor.durationSeconds', { seconds: Math.floor(seconds) })
  if (seconds < 3600) return t('editor.durationMinutes', { minutes: Math.floor(seconds / 60), seconds: Math.floor(seconds % 60) })
  return t('editor.durationHours', { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) })
}

export function runtimeLabel(session: Session, catalog?: RuntimeCatalog | null): string {
  const backend = runtimeBackendCatalogFor(catalog, session.backend, session.codex_provider, session.codex_provider_catalog)
  const custom = session.backend === 'codex' && session.codex_provider === 'custom'
  const model = session.model?.trim()
  const effort = session.backend === 'cursor' || session.backend === 'opencode' ? '' : session.effort?.trim()
  const modelLabel = model
    ? backend?.models.find(option => option.value === model)?.label ?? model
    : backend?.models.find(option => option.value === (backend.default_model ?? ''))?.label ?? (backend?.default_model?.trim() || (custom ? t('codexProvider.chooseModel') : session.backend === 'claude' ? 'Sonnet' : session.backend === 'codex' ? 'GPT' : session.backend === 'opencode' ? t('opencode.defaultModel') : 'Auto'))
  const supportedEfforts = custom ? runtimeEffortOptions(catalog, session.backend, session.model, null, session.codex_provider, session.codex_provider_catalog) : null
  const effortLabel = session.backend === 'cursor' || session.backend === 'opencode'
    ? null
    : effort
      ? supportedEfforts ? supportedEfforts.find(option => option.value === effort)?.label : backend?.efforts.find(option => option.value === effort)?.label ?? effort
      : custom ? null : backend?.default_effort
  return [modelLabel, effortLabel].filter(Boolean).join(' · ')
}

export function shortId(value?: string | null): string {
  return value?.trim() ? value.slice(0, 10) : '–'
}

export function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}
