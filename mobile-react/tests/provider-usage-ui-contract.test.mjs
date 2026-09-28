import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const api = source('src/api/AgentServerClient.ts')
const helper = source('src/lib/provider-usage.ts')
const events = source('src/lib/provider-usage-events.ts')
const panel = source('src/components/ProviderUsagePanel.tsx')
const codexControls = source('src/components/CodexControls.tsx')
const claudeContext = source('src/components/ClaudeContextIndicator.tsx')
const store = source('src/store/useAppStore.ts')

test('the client exposes a typed native-control usage method', () => {
  assert.match(api, /import \{ parseProviderUsage, type ProviderUsageSnapshot, type UsageBackend \} from '\.\.\/lib\/provider-usage'/)
  assert.match(api, /runtimeUsage\(backend: UsageBackend, sessionId: string, options: \{ refresh\?: boolean \} = \{\}\): Promise<ProviderUsageSnapshot>/)
  assert.match(api, /new URLSearchParams\(\{ backend, session_id: sessionId \}\)/)
  assert.match(api, /if \(options\.refresh\) query\.set\('refresh', 'true'\)/)
  assert.match(api, /parseProviderUsage\(await this\.request\(`\/api\/runtime\/usage\?\$\{query\}`, \{\}, 30_000, false, 'native-control'\), backend\)/)
})

test('the timeline stream routes ephemeral provider_usage_changed packets', () => {
  assert.match(api, /onProviderUsage\?: \(backend: UsageBackend\) => void,/)
  assert.match(api, /if \(isProviderUsageChanged\(packet\)\) \{\s*if \(packet\.session_id === sessionId\) onProviderUsage\?\.\(packet\.backend\)/)
  assert.match(api, /packet\.type === 'provider_usage_changed'/)
  assert.match(api, /packet\.ephemeral === true/)
  assert.match(store, /import \{ publishProviderUsageChanged \} from '\.\.\/lib\/provider-usage-events'/)
  assert.match(store, /publishProviderUsageChanged\(\{\s*connection: scope\.client,[\s\S]*?sessionId,\s*backend,\s*\}\)/)
  assert.match(events, /export function subscribeProviderUsageChanged/)
  assert.match(events, /export function publishProviderUsageChanged/)
})

test('the pure helper ports the desktop labels and reasons', () => {
  assert.match(helper, /export function parseProviderUsage/)
  assert.match(helper, /'Current session \(5h\)'/)
  assert.match(helper, /'Current week \(all models\)'/)
  assert.match(helper, /'5-hour limit'/)
  assert.match(helper, /'Weekly limit'/)
  assert.match(helper, /export function formatResetDelay/)
  assert.match(helper, /export function usedText/)
  assert.match(helper, /Claude reports usage only while it runs; it appears after a Claude turn on this server\./)
  assert.match(helper, /Codex has not reported usage yet\./)
  assert.match(helper, /Usage is not reported for custom API endpoints\./)
  assert.match(helper, /Usage requires the Codex app-server transport\./)
})

test('the usage section loads on open, subscribes, and stays connection-scoped', () => {
  assert.match(panel, /export function ProviderUsageSection\(\{ session \}: \{ session: Session \}\)/)
  // Default expanded, collapsible header.
  assert.match(panel, /const \[open, setOpen\] = useState\(true\)/)
  assert.match(panel, /onPress=\{\(\) => setOpen\(value => !value\)\}/)
  // Gated on the provider_usage capability; hidden otherwise.
  assert.match(panel, /state\.health\?\.capabilities\?\.provider_usage/)
  assert.match(panel, /const supported = available && backend !== null/)
  assert.match(panel, /if \(!view\.supported \|\| !view\.backend\) return null/)
  // Loads on mount, refetches on the ephemeral event, refresh forces refresh=true.
  assert.match(panel, /subscribeProviderUsageChanged\(notification => \{/)
  assert.match(panel, /connection\.runtimeUsage\(backend, session\.id, \{ refresh \}\)/)
  assert.match(panel, /refreshRef\.current = \(\) => read\(true\)/)
  assert.match(panel, /read\(false\)/)
  // Connection-scoping so a server switch mid-request is ignored.
  assert.match(panel, /client === connection/)
  assert.match(panel, /connection\.isValidated/)
  assert.match(panel, /store\.selectedSessionId === session\.id/)
})

test('the usage section renders windows, credits, reason, observed time, and refresh', () => {
  assert.match(panel, /windowLabel\(window, backend\)/)
  assert.match(panel, /usedText\(used\)/)
  assert.match(panel, /formatResetDelay\(resetsAt, now\)/)
  assert.match(panel, /`Resets in \$\{delay\}`/)
  assert.match(panel, /providerUsageReason\(snapshot\.reason, backend\)/)
  assert.match(panel, /snapshot\?\.credits/)
  assert.match(panel, /Reported \{formatClock\(Date\.parse\(snapshot\.observed_at\)\)\}/)
  assert.match(panel, /testID="provider-usage-refresh"/)
  assert.match(panel, /window\.status === 'rejected' \? colors\.red : window\.status === 'allowed_warning' \? colors\.orange/)
})

test('both backends mount the usage section in their thread-controls sheet', () => {
  assert.match(codexControls, /import \{ ProviderUsageSection \} from '\.\/ProviderUsagePanel'/)
  assert.match(codexControls, /<ProviderUsageSection session=\{session\} \/>/)
  assert.match(claudeContext, /import \{ ProviderUsageSection \} from '\.\/ProviderUsagePanel'/)
  assert.match(claudeContext, /<ProviderUsageSection session=\{session\} \/>/)
})
