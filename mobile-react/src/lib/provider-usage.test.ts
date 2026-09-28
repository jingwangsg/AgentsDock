import {
  clampPercent,
  formatResetDelay,
  formatUsagePercent,
  parseProviderUsage,
  providerUsageReason,
  usedText,
  windowLabel,
  type ProviderUsageWindow,
} from './provider-usage'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertThrows(callback: () => void, message: string): void {
  try {
    callback()
  } catch {
    return
  }
  throw new Error(message)
}

function window(overrides: Partial<ProviderUsageWindow>): ProviderUsageWindow {
  return { id: 'w', label: null, used_percent: null, resets_at: null, window_minutes: null, observed_at: 't', ...overrides }
}

// parseProviderUsage accepts available and unavailable snapshots and rejects mismatches.
const unavailable = parseProviderUsage({
  backend: 'claude', status: 'unavailable', source: null, observed_at: null,
  account_kind: 'unknown', windows: [], reason: 'not_reported',
}, 'claude')
assert(unavailable.status === 'unavailable' && unavailable.reason === 'not_reported', 'unavailable snapshot round-trips')

const available = parseProviderUsage({
  backend: 'codex', status: 'available', source: 'codex-account', observed_at: '2026-09-28T10:00:00Z',
  account_kind: 'chatgpt',
  windows: [{ id: 'primary', label: null, used_percent: 42.4, resets_at: 1000, window_minutes: 300, observed_at: 't', status: 'allowed' }],
  credits: { balance: '5.00', has_credits: true, unlimited: false },
}, 'codex')
assert(available.windows[0].used_percent === 42.4 && available.credits?.balance === '5.00', 'available snapshot preserves windows and credits')

assertThrows(() => parseProviderUsage({ backend: 'codex', status: 'available', windows: [] }, 'claude'), 'backend mismatch must throw')
assertThrows(() => parseProviderUsage(null, 'codex'), 'null must throw')
assertThrows(() => parseProviderUsage({ backend: 'codex', status: 'wat', windows: [] }, 'codex'), 'bad status must throw')

// Percent formatting rounds and clamps.
assert(formatUsagePercent(42.4) === '42' && formatUsagePercent(42.6) === '43', 'percent rounds to the nearest integer')
assert(clampPercent(-5) === 0 && clampPercent(140) === 100, 'percent is clamped to 0..100')
assert(usedText(12.2) === '12% used', 'used text reads "N% used"')

// Window labels: Claude ids map to named windows; Codex maps durations to limit names.
assert(windowLabel(window({ id: 'five_hour', window_minutes: 300 }), 'claude') === 'Current session (5h)', 'claude five_hour label')
assert(windowLabel(window({ id: 'seven_day' }), 'claude') === 'Current week (all models)', 'claude seven_day label')
assert(windowLabel(window({ id: 'seven_day_opus' }), 'claude') === 'Current week (Opus)', 'claude opus label')
assert(windowLabel(window({ id: 'seven_day_sonnet' }), 'claude') === 'Current week (Sonnet)', 'claude sonnet label')
assert(windowLabel(window({ id: 'primary', window_minutes: 300 }), 'codex') === '5-hour limit', 'codex 300-minute label')
assert(windowLabel(window({ id: 'weekly', window_minutes: 10080 }), 'codex') === 'Weekly limit', 'codex weekly label')
assert(windowLabel(window({ id: 'other', window_minutes: 90 }), 'codex') === '90 minutes', 'codex arbitrary minutes label')
assert(windowLabel(window({ id: 'named', label: 'GPT-5', window_minutes: 300 }), 'codex') === 'GPT-5 · 5-hour limit', 'codex label combines with the period')
assert(windowLabel(window({ id: 'bare' }), 'codex') === 'Usage allowance', 'codex fallback label')

// Reset delay: days/hours/minutes, and null once passed.
const now = 1_000_000_000_000
assert(formatResetDelay(now + (2 * 1440 + 3 * 60) * 60_000, now) === '2d 3h', 'delay above a day shows days and hours')
assert(formatResetDelay(now + 90 * 60_000, now) === '1h 30m', 'delay above an hour shows hours and minutes')
assert(formatResetDelay(now + 45 * 60_000, now) === '45m', 'sub-hour delay shows minutes')
assert(formatResetDelay(now + 2 * 60_000 * 60 * 24, now) === '2d', 'a whole-day delay omits zero hours')
assert(formatResetDelay(now - 1000, now) === null, 'a passed reset returns null')

// Reason sentences cover the endpoint's reasons and vary by backend for "not reported".
assert(providerUsageReason('custom_endpoint', 'codex') === 'Usage is not reported for custom API endpoints.', 'custom endpoint reason')
assert(providerUsageReason('unsupported_transport', 'codex') === 'Usage requires the Codex app-server transport.', 'unsupported transport reason')
assert(providerUsageReason('account_usage_unavailable', 'claude') === 'This account type does not report usage.', 'account type reason')
assert(providerUsageReason('not_reported', 'codex') === 'Codex has not reported usage yet.', 'codex not-reported reason')
assert(providerUsageReason(undefined, 'claude') === 'Claude reports usage only while it runs; it appears after a Claude turn on this server.', 'claude not-reported reason')
assert(providerUsageReason('temporarily_unavailable', 'codex') === 'Usage is temporarily unavailable.', 'temporary reason fallback')

console.log('provider usage helper regressions passed')
