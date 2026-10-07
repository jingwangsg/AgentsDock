import assert from 'node:assert/strict'
import type { Health } from '../types'
import {
  cursorLocalSessionImportSupported,
  localSessionImportBatchLimit,
  localSessionImportCapability,
  localSessionImportListLimit,
  parseBulkImportSessionResultsResponse,
  parseLocalSessionCandidatesResponse,
} from './local-session-import'

const capability = { available: true, required: false, message: '', action: null, version: 1, max_batch_items: 25, max_list_items: 500 }
const supported = (overrides: Partial<Health> = {}): Health => ({ ok: true, api_contract_version: 15, capabilities: { local_session_import_v1: capability }, ...overrides })

// Capability gating: API 15, additive versions, and the client's hard limits.
assert.notEqual(localSessionImportCapability(supported()), null)
assert.equal(localSessionImportCapability(supported({ api_contract_version: 14 })), null)
assert.equal(localSessionImportCapability(supported({ capabilities: {} })), null)
assert.equal(localSessionImportCapability(supported({ capabilities: { local_session_import_v1: { ...capability, available: false } } })), null)
assert.notEqual(localSessionImportCapability(supported({ capabilities: { local_session_import_v1: { ...capability, version: 2 } } })), null)
const oversized = localSessionImportCapability(supported({ capabilities: { local_session_import_v1: { ...capability, max_batch_items: 1_000, max_list_items: 10_000 } } }))!
assert.equal(localSessionImportBatchLimit(oversized), 25)
assert.equal(localSessionImportListLimit(oversized), 500)

// Cursor needs its own public-snapshot capability on top of the base import.
assert.equal(cursorLocalSessionImportSupported(supported()), false)
for (const [override, expected] of [[{}, true], [{ available: false }, false], [{ version: 0 }, false], [{ history_mode: 'unknown' }, false]] as const) {
  const health = supported({ capabilities: { local_session_import_v1: capability, local_session_import_cursor_v1: { available: true, version: 1, history_mode: 'initial_text_snapshot', ...override } } })
  assert.equal(cursorLocalSessionImportSupported(health), expected)
}

// Candidate lists: malformed labels fall back without hiding other rows; duplicate identities are refused.
const sessions = parseLocalSessionCandidatesResponse({ sessions: [
  { provider_session_id: 'claude-session-1', backend: 'claude', label: 'Linear-123 \u001b[31mfix', updated_at: '2026-08-01T00:00:00Z', cwd: '/work' },
  { provider_session_id: 'codex-session-2', backend: 'codex', label: null, updated_at: '2026-08-02T00:00:00Z', cwd: null },
  { provider_session_id: 'cursor-session-3', backend: 'cursor', label: '普通标题 — 🚀', updated_at: '2026-08-03T00:00:00Z', cwd: null },
] })
assert.deepEqual(sessions.map(session => session.label), ['Claude chat claude-s', 'Codex chat codex-se', '普通标题 — 🚀'])
assert.throws(() => parseLocalSessionCandidatesResponse({ sessions: [
  { provider_session_id: 'p', backend: 'claude', label: 'One', updated_at: '2026-08-01T00:00:00Z', cwd: null },
  { provider_session_id: 'p', backend: 'claude', label: 'Two', updated_at: '2026-08-02T00:00:00Z', cwd: null },
] }), /duplicate local sessions/i)
assert.throws(() => parseLocalSessionCandidatesResponse({ sessions: [{ provider_session_id: 'p', backend: 'other', label: 'x', updated_at: 'now', cwd: null }] }))

// Import results must answer exactly the requested identities, with consistent success fields.
const requested = [{ provider_session_id: 'p1', backend: 'claude' as const }, { provider_session_id: 'p1', backend: 'codex' as const }]
assert.equal(parseBulkImportSessionResultsResponse({ results: [
  { provider_session_id: 'p1', backend: 'claude', session_id: 'chat-a', ok: true, imported: 3 },
  { provider_session_id: 'p1', backend: 'codex', session_id: null, ok: false, imported: 0, code: 'empty', error: 'No messages' },
] }, requested).length, 2)
assert.throws(() => parseBulkImportSessionResultsResponse({ results: [
  { provider_session_id: 'p1', backend: 'claude', session_id: 'chat-a', ok: true, imported: 0 },
  { provider_session_id: 'p1', backend: 'codex', session_id: null, ok: false, imported: 0 },
] }, requested), /internally inconsistent/i)
assert.throws(() => parseBulkImportSessionResultsResponse({ results: [
  { provider_session_id: 'other', backend: 'claude', session_id: 'chat-a', ok: true, imported: 1 },
] }, [requested[0]]), /does not match the request/i)
assert.throws(() => parseBulkImportSessionResultsResponse({ results: [] }, requested), /result count/i)

console.log('local session import regressions passed')
