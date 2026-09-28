import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const api = source('src/api/AgentServerClient.ts')
const types = source('src/types.ts')
const composer = source('src/components/Composer.tsx')
const header = source('src/components/ChatHeader.tsx')
const contextIndicator = source('src/components/ClaudeContextIndicator.tsx')
const runtimeProvider = source('src/components/ClaudeRuntimeContext.tsx')
const interactionShelf = source('src/components/ClaudeInteractionShelf.tsx')
const contextUsage = source('src/lib/claude-context-usage.ts')
const store = source('src/store/useAppStore.ts')

test('mobile exposes the complete current Claude SDK runtime contract', () => {
  assert.match(types, /export type ClaudePermissionMode = 'default' \| 'acceptEdits' \| 'plan' \| 'bypassPermissions' \| 'dontAsk' \| 'auto'/)
  assert.match(types, /permission_modes\?: ClaudePermissionMode\[\]/)
  assert.match(types, /context_usage_snapshot\?: ClaudeTokenUsage \| null/)
  assert.match(types, /context_usage_state\?: 'available' \| 'cleared' \| 'unavailable' \| null/)
  assert.match(types, /context_usage_refresh\?: boolean/)
  assert.match(types, /context_usage_refreshed\?: boolean/)
  // Per-chat permission modes are no longer sent; the server applies full access.
  assert.doesNotMatch(api, /claude_permission_mode/)
  assert.match(api, /refreshClaudeContextUsage\(sessionId: string\)[\s\S]*?claude\/context-usage\/refresh`[\s\S]*?\{\}/)
})

test('turn admission captures the composer draft before every dispatch path', () => {
  assert.match(composer, /admissionToken,/)
  assert.match(composer, /const admittedDraft = consumeComposer \? currentDraft : undefined/)
  assert.match(composer, /const admittedFiles = consumeComposer \? currentUploads : undefined/)
  assert.match(composer, /const admissionPreflight = admitting && !sending/)
  assert.match(composer, /editable=\{!switching && !admissionPreflight\}/)
  assert.match(store, /turnAdmissionTokens: Record<string, string>/)
  assert.match(store, /const originalDraft = options\?\.admittedDraft \?\? get\(\)\.drafts\[sessionId\] \?\? ''/)
  assert.match(store, /const files = consumeComposer \? options\?\.admittedFiles \?\? get\(\)\.uploads\[sessionId\] \?\? \[\] : \[\]/)
  assert.match(store, /state\.turnAdmissionTokens\[sessionId\] !== token/)
  assert.match(store, /patch\.backend !== before\.backend[\s\S]*?turnAdmissionTokens\[sessionId\]/)
})

test('Claude context consumption is visible and refreshable like the Mac app', () => {
  assert.match(header, /<ClaudeContextIndicator \/>/)
  assert.match(contextIndicator, /runtime\.context_usage_snapshot !== undefined/)
  assert.match(contextIndicator, /testID="claude-context-usage"/)
  assert.match(contextIndicator, /void refreshContextUsage\(\)/)
  assert.match(contextIndicator, /context_usage_state/)
  assert.match(contextIndicator, /runtime\?\.features\?\.context_usage_refresh === true/)
  assert.match(contextIndicator, /runtimeStatus === 'idle'/)
  assert.match(runtimeProvider, /connection\.refreshClaudeContextUsage\(expectedSessionId\)/)
  assert.match(runtimeProvider, /runtimeRef\.current\?\.features\?\.context_usage_refresh !== true[\s\S]*?performRefresh\('contextUsage'\)/)
  assert.match(runtimeProvider, /runtimeError: string \| null/)
  assert.match(runtimeProvider, /interactionError: string \| null/)
  assert.match(runtimeProvider, /contextUsageError: string \| null/)
  assert.doesNotMatch(interactionShelf, /contextUsageError/)
  assert.match(interactionShelf, /error=\{interactionError \?\? \(runtime === null \? runtimeError : null\)\}/)
  assert.match(contextUsage, /\['context_usage', 'contextUsage', 'native', 'raw'\]/)
  assert.match(contextUsage, /clampPercent\(explicitPercent \?\? contextTokens \/ effectiveContextWindow \* 100\)/)
})

