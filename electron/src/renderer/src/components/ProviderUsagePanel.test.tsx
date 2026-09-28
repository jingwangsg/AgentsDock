import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '@shared/i18n'
import type { ProviderUsageSnapshot } from '@shared/provider-usage'
import type { Health, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { ProviderUsagePanel } from './ProviderUsagePanel'

const codexChat = { id: 'chat-a', backend: 'codex', codex_provider: 'default' } as Session
const claudeChat = { id: 'chat-b', backend: 'claude' } as Session
const scope = { profileId: 'server-a', profileGeneration: 3, serverIdentity: 'identity-a' }
const observedAt = '2026-09-24T12:00:00Z'
const hour = 3600
const resetsAt = 1790254800 // 2026-09-24T13:00:00Z
const codexUsage: ProviderUsageSnapshot = {
  backend: 'codex', status: 'available', source: 'codex-account', account_kind: 'chatgpt', observed_at: observedAt,
  windows: [
    { id: 'codex:primary', label: null, used_percent: 25, resets_at: resetsAt, window_minutes: 300, observed_at: observedAt },
    { id: 'codex:secondary', label: null, used_percent: 60.4, resets_at: resetsAt + 51 * hour, window_minutes: 10080, observed_at: observedAt }
  ],
  credits: { balance: '12.5', has_credits: true, unlimited: false }
}
const claudeUsage: ProviderUsageSnapshot = {
  backend: 'claude', status: 'available', source: 'claude-events', account_kind: 'subscription', observed_at: observedAt,
  windows: [
    { id: 'five_hour', label: null, used_percent: 42, resets_at: resetsAt, window_minutes: 300, observed_at: observedAt, status: 'allowed' },
    { id: 'seven_day', label: null, used_percent: 81, resets_at: resetsAt + 51 * hour, window_minutes: 10080, observed_at: observedAt, status: 'allowed_warning' },
    { id: 'seven_day_opus', label: 'Opus', used_percent: 100, resets_at: resetsAt + 51 * hour, window_minutes: 10080, observed_at: observedAt, status: 'rejected' },
    { id: 'seven_day_sonnet', label: 'Sonnet', used_percent: null, resets_at: null, window_minutes: 10080, observed_at: observedAt }
  ]
}

function fixture(value: ProviderUsageSnapshot) {
  const listeners = new Map<string, (value: any) => void>()
  const usage = vi.fn().mockResolvedValue(value)
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: {
    runtime: { usage }, events: { on: vi.fn((key, fn) => { listeners.set(key, fn); return () => listeners.delete(key) }) }
  } })
  useAppStore.setState({ activeProfileId: scope.profileId, profileGeneration: scope.profileGeneration, connected: true,
    health: { server_identity: scope.serverIdentity, server_instance_id: 'instance-a',
      capabilities: { provider_usage: { available: true, version: 1 } } } as Health })
  return { usage, listeners }
}

beforeEach(() => {
  // Only Date is faked so the relative reset text is deterministic; timers stay real for testing-library.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-24T12:15:00Z'))
})
afterEach(() => { cleanup(); setLocale('en'); vi.useRealTimers(); Reflect.deleteProperty(window, 'agentsDock') })

describe('provider usage panel', () => {
  it('lists Codex rate-limit windows with percent used, relative reset time and credits', async () => {
    const { usage } = fixture(codexUsage)
    render(<ProviderUsagePanel session={codexChat} />)
    expect(await screen.findByText('5-hour limit')).toBeInTheDocument()
    expect(usage).toHaveBeenCalledExactlyOnceWith(scope, 'codex', 'chat-a', false)
    expect(screen.getByRole('button', { name: /^Usage/ })).toHaveTextContent('60% used')
    expect(screen.getByText('25% used')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: '5-hour limit used' })).toHaveAttribute('value', '25')
    expect(screen.getByText('Resets in 45m')).toHaveAttribute('title')
    expect(screen.getByText('Weekly limit')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Weekly limit used' })).toHaveAttribute('value', '60.4')
    expect(screen.getByText('Resets in 2d 3h')).toBeInTheDocument()
    expect(screen.getByText('12.5')).toBeInTheDocument()
    expect(screen.getByText(/^Reported /)).toBeInTheDocument()
  })

  it('names Claude windows like the CLI and marks warning and rejected windows', async () => {
    fixture(claudeUsage)
    render(<ProviderUsagePanel session={claudeChat} />)
    expect(await screen.findByText('Current session (5h)')).toBeInTheDocument()
    expect(screen.getByText('42% used')).toBeInTheDocument()
    const week = screen.getByText('Current week (all models)').closest('.provider-usage-window')
    expect(week).toHaveClass('warning')
    expect(week).toHaveTextContent('81% used')
    const opus = screen.getByText('Current week (Opus)').closest('.provider-usage-window')
    expect(opus).toHaveClass('rejected')
    expect(opus).toHaveTextContent('100% used')
    expect(screen.getByText('Current week (Sonnet)').closest('.provider-usage-window')).toHaveTextContent('Not reported')
    expect(screen.getByRole('button', { name: /^Usage/ })).toHaveTextContent('Limit reached')
    expect(screen.getByText(/other windows may not have been reported/)).toBeInTheDocument()
  })

  it('explains why usage is unavailable instead of showing empty bars', async () => {
    fixture({ backend: 'codex', status: 'unavailable', source: null, account_kind: 'custom', observed_at: null, windows: [], reason: 'custom_endpoint' })
    const view = render(<ProviderUsagePanel session={{ ...codexChat, codex_provider: 'custom' }} />)
    expect(await screen.findByText('Usage is not reported for custom API endpoints.')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Usage/ })).toHaveTextContent('Not available')
    view.unmount()
    fixture({ backend: 'claude', status: 'unavailable', source: null, account_kind: 'unknown', observed_at: null, windows: [], reason: 'not_reported' })
    render(<ProviderUsagePanel session={claudeChat} />)
    expect(await screen.findByText(/after a Claude turn has run on this server/)).toBeInTheDocument()
  })

  it('refreshes on demand with refresh=true and refetches only on a matching usage notice', async () => {
    const { usage, listeners } = fixture(codexUsage)
    render(<ProviderUsagePanel session={codexChat} />)
    await screen.findByText('5-hour limit')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }))
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(2))
    expect(usage).toHaveBeenLastCalledWith(scope, 'codex', 'chat-a', true)
    act(() => listeners.get('provider-usage:changed')!({ ...scope, sessionId: 'other', backend: 'codex' }))
    expect(usage).toHaveBeenCalledTimes(2)
    act(() => listeners.get('provider-usage:changed')!({ ...scope, sessionId: codexChat.id, backend: 'codex' }))
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(3))
    expect(usage).toHaveBeenLastCalledWith(scope, 'codex', 'chat-a', false)
  })

  it('collapses from its header and disappears when the server lacks the capability', async () => {
    fixture(codexUsage)
    render(<ProviderUsagePanel session={codexChat} />)
    await screen.findByText('5-hour limit')
    fireEvent.click(screen.getByRole('button', { name: /^Usage/ }))
    expect(screen.queryByText('5-hour limit')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Usage/ })).toHaveAttribute('aria-expanded', 'false')
    act(() => useAppStore.setState({ health: { capabilities: {} } as Health }))
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
