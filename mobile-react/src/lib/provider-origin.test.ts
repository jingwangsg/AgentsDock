import type { Event } from '../types'
import {
  hasProviderUserProvenance,
  isImportedClaudeControlCompanion,
  isImportedCodexGoalContext,
  isImportedCodexRuntimeNotification,
  isImportedProviderControlMetadata,
  isImportedProviderInterruption,
  isImportedSourceProvenAssistantReplay,
  isImportedSourceProvenNativeReplay,
  isImportedSourceProvenRepair,
} from './provider-origin'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const interruption = (patch: Partial<Event> = {}): Event => ({
  id: 'imported-control',
  session_id: 'chat-1',
  seq: 2,
  type: 'provider_interruption',
  ts: '2026-09-09T10:00:00Z',
  imported: true,
  backend: 'claude',
  provider_origin: {
    provider: 'claude',
    kind: 'interruption',
    event_id: '11111111-1111-4111-8111-111111111111',
    session_id: '22222222-2222-4222-8222-222222222222',
    timestamp: '2026-09-09T10:00:00Z',
    cause: 'unknown',
  },
  ...patch,
})
const companion = (patch: Partial<Event> = {}): Event => interruption({
  type: 'turn_finished', metadata_only: true, run_id: 'import_control-only', provider_origin: undefined, ...patch,
})

// Source-proven assistant replays.
const repairedReplay = (): Event => interruption({
  type: 'assistant_text', run_id: 'import_mixed', text: '', metadata_only: true,
  provider_history_repair: 'source_proven_assistant_replay',
  provider_origin: { provider: 'claude', event_id: 'source-assistant', session_id: 'provider-session', timestamp: '2026-09-09T10:00:00.321Z' },
})
assert(isImportedSourceProvenAssistantReplay(repairedReplay()), 'an exact server-proven assistant replay is control metadata')
assert(isImportedProviderControlMetadata(repairedReplay()), 'assistant replays count as provider control metadata')
for (const change of [{ imported: false }, { type: 'turn_started' }, { metadata_only: undefined },
  { text: 'Nonempty' }, { provider_history_repair: undefined }, { provider_user_authored: true },
  { provider_origin: undefined }] as Partial<Event>[]) {
  assert(!isImportedSourceProvenAssistantReplay({ ...repairedReplay(), ...change }), `assistant replay must reject ${JSON.stringify(change)}`)
}

// Source-proven imported history repairs.
const repairedStart = (): Event => interruption({
  type: 'turn_started', run_id: 'import_history', provider_origin: undefined, prompt: '', provider_history_repair: 'source_proven_import',
})
assert(isImportedSourceProvenRepair(repairedStart()), 'an explicit blank source-proven import start is a repair')
assert(isImportedProviderControlMetadata(repairedStart()), 'repairs count as provider control metadata')
for (const patch of [{ imported: false }, { prompt: 'real user text' }, { provider_history_repair: undefined }, { provider_user_authored: true }] as Partial<Event>[]) {
  assert(!isImportedSourceProvenRepair({ ...repairedStart(), ...patch }), `repair must reject ${JSON.stringify(patch)}`)
}

// Source-proven native Codex replays.
const nativeReplay = (patch: Partial<Event> = {}): Event => interruption({
  type: 'turn_started', run_id: 'import_native', backend: 'codex', prompt: '', metadata_only: true,
  provider_history_repair: 'source_proven_native_replay',
  provider_origin: {
    provider: 'codex', kind: 'user', event_id: 'evt', session_id: 'thread', turn_id: 'turn', native_event_id: 'native',
    timestamp: '2026-09-09T10:00:00Z', source_text_sha256: 'a'.repeat(64),
  },
  ...patch,
})
assert(isImportedSourceProvenNativeReplay(nativeReplay()), 'a fully proven native user replay is control metadata')
assert(isImportedSourceProvenNativeReplay(nativeReplay({
  type: 'assistant_text', text: '', provider_origin: { ...nativeReplay().provider_origin!, kind: 'assistant' } as Event['provider_origin'],
})), 'a fully proven native assistant replay is control metadata')
for (const patch of [
  { backend: 'claude' }, { prompt: 'user text' }, { metadata_only: undefined },
  { provider_origin: { ...nativeReplay().provider_origin, kind: 'assistant' } },
  { provider_origin: { ...nativeReplay().provider_origin, source_text_sha256: 'not-a-hash' } },
  { provider_origin: { ...nativeReplay().provider_origin, timestamp: '2026-09-09' } },
] as Partial<Event>[]) {
  assert(!isImportedSourceProvenNativeReplay(nativeReplay(patch)), `native replay must reject ${JSON.stringify(patch)}`)
}

// Imported Claude control companions.
for (const type of ['history_imported', 'turn_finished']) {
  assert(isImportedClaudeControlCompanion(companion({ type })), `${type} companion is hidden bookkeeping`)
  assert(isImportedProviderControlMetadata(companion({ type })), `${type} companion counts as control metadata`)
}
for (const patch of [{ metadata_only: undefined }, { imported: false }, { backend: 'codex' }, { run_id: 'live-run' }, { type: 'assistant_text' }] as Partial<Event>[]) {
  assert(!isImportedClaudeControlCompanion(companion(patch)), `companion must reject ${JSON.stringify(patch)}`)
}

// Imported provider interruptions.
assert(isImportedProviderInterruption(interruption()), 'an exact provider interruption record is proven metadata')
assert(isImportedProviderInterruption(interruption({ backend: undefined })), 'a missing backend still matches the Claude-only contract')
for (const [name, patch] of [
  ['other type', { type: 'turn_started' }],
  ['not imported', { imported: false }],
  ['missing import marker', { imported: undefined }],
  ['other backend', { backend: 'codex' }],
  ['missing provenance', { provider_origin: undefined }],
  ['null provenance', { provider_origin: null }],
  ['string provenance', { provider_origin: 'interruption' }],
] as Array<[string, Record<string, unknown>]>) {
  assert(!isImportedProviderInterruption({ ...interruption(), ...patch } as Event), `interruption must reject ${name}`)
}
for (const [name, patch] of [
  ['other provider', { provider: 'codex' }],
  ['other kind', { kind: 'message' }],
  ['empty event ID', { event_id: '' }],
  ['noncanonical event ID', { event_id: '11111111111141118111111111111111' }],
  ['missing session ID', { session_id: undefined }],
  ['noncanonical session ID', { session_id: 'provider-session' }],
  ['invalid timestamp', { timestamp: '2026-99-99T10:00:00Z' }],
  ['date without time', { timestamp: '2026-09-09' }],
  ['time without zone', { timestamp: '2026-09-09T10:00:00' }],
  ['missing timestamp', { timestamp: undefined }],
  ['unrecognized cause', { cause: 'user' }],
  ['missing cause', { cause: undefined }],
] as Array<[string, Record<string, unknown>]>) {
  const record = interruption()
  assert(
    !isImportedProviderInterruption({ ...record, provider_origin: { ...record.provider_origin, ...patch } } as Event),
    `interruption provenance must reject ${name}`,
  )
}
for (const imported of [false, true]) {
  assert(
    !isImportedProviderInterruption(interruption({ type: 'turn_started', imported, provider_origin: undefined, prompt: '[Request interrupted by user]' })),
    'interruption text alone never classifies a user message',
  )
}

// Codex runtime context recovered from imported history.
const goalPrompt = '<codex_internal_context source="goal">Continue working toward the active thread goal. <objective>Ship it</objective></codex_internal_context>'
const goalContext = (patch: Partial<Event> = {}): Event => interruption({
  type: 'turn_started', backend: 'codex', run_id: 'import_goal', provider_runtime_context: 'goal', metadata_only: true,
  provider_origin: undefined, prompt: goalPrompt, ...patch,
})
assert(isImportedCodexGoalContext(goalContext()), 'an exact goal runtime envelope with server metadata is runtime context')
assert(isImportedCodexGoalContext(goalContext({ prompt: '' })), 'a blank proven goal injection is runtime context')
for (const patch of [
  { provider_user_authored: true }, { metadata_only: undefined }, { provider_runtime_context: undefined },
  { prompt: 'I pasted <codex_internal_context source="goal">Continue working toward the active thread goal. <objective>x</objective></codex_internal_context>' },
  { prompt: goalPrompt.replace('<objective>', '<objective></objective><objective>') },
] as Partial<Event>[]) {
  assert(!isImportedCodexGoalContext(goalContext(patch)), `goal context must reject ${JSON.stringify(patch)}`)
}
const runtimeNotification = (patch: Partial<Event> = {}): Event => interruption({
  type: 'turn_started', backend: 'codex', run_id: 'import_notice', provider_runtime_context: 'subagent_notification', metadata_only: true, prompt: '',
  provider_origin: {
    provider: 'codex', kind: 'subagent_notification', event_id: 'evt', session_id: 'thread', turn_id: 'turn',
    timestamp: '2026-09-09T10:00:00Z', source_text_sha256: 'b'.repeat(64),
  },
  ...patch,
})
assert(isImportedCodexRuntimeNotification(runtimeNotification()), 'a source-proven runtime notification is runtime context')
for (const patch of [
  { prompt: 'quoted' }, { provider_user_authored: true },
  { provider_origin: { ...runtimeNotification().provider_origin, kind: 'turn_aborted' } },
  { provider_origin: { ...runtimeNotification().provider_origin, source_text_sha256: '' } },
] as Partial<Event>[]) {
  assert(!isImportedCodexRuntimeNotification(runtimeNotification(patch)), `runtime notification must reject ${JSON.stringify(patch)}`)
}

// Provider user provenance aliases.
assert(hasProviderUserProvenance(interruption({ provider_user_authored: true })), 'explicit provider authorship is provenance')
assert(hasProviderUserProvenance({ ...interruption(), clientUserMessageId: 'abc' } as unknown as Event), 'legacy client message IDs are provenance')
assert(hasProviderUserProvenance(interruption({ provider_origin: { provider: 'codex', kind: 'user' } })), 'a user-kind origin is provenance')
assert(!hasProviderUserProvenance(interruption({ provider_origin: { provider: 'codex', kind: 'assistant' } })), 'an assistant origin is not user provenance')
assert(!hasProviderUserProvenance(interruption({ prompt: 'clientUserMessageId=abc' })), 'message text never grants provenance')

console.log('provider origin predicates passed')
