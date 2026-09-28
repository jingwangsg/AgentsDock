import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const client = source('src/api/AgentServerClient.ts')
const store = source('src/store/useAppStore.ts')
const bar = source('src/components/RunActivityBar.tsx')
const rows = source('src/components/SubagentRows.tsx')
const lib = source('src/lib/run-activity.ts')
const types = source('src/types.ts')

test('the snapshot route is the phone\'s complete subagent source', () => {
  assert.match(client, /subagents\(sessionId: string, limit = 64\): Promise<SubagentSnapshot>/)
  assert.match(client, /\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/subagents\?limit=\$\{limit\}/)
  for (const field of ['subagent_title', 'subagent_nickname', 'subagent_path', 'subagent_parent_thread_id', 'subagent_log']) {
    assert.match(types, new RegExp(`^  ${field}\\?: `, 'm'), `Event declares ${field}`)
  }
})

test('streamed subagent_state feeds the slice, never the timeline, and a rewind clears and refetches it', () => {
  assert.match(store, /^  'subagent_state',$/m, 'still a timeline-internal type')
  assert.match(store, /if \(event\.type === 'subagent_state'\) set\(state => \(\{ subagentsBySession: withSubagentStates\(state\.subagentsBySession, sessionId, \[event\]\) \}\)\)/)
  assert.match(store, /if \(event\.type === 'history_rewound'\) \{[\s\S]*?delete subagentsBySession\[sessionId\][\s\S]*?void get\(\)\.refreshSubagents\(sessionId\)/)
  // Latest record per id wins; an equal or older seq keeps the existing object.
  assert.match(store, /if \(existing && existing\.seq >= event\.seq\) continue/)
})

test('the snapshot is fetched on open and turn end, and polled every 5 s only while the open chat is active', () => {
  assert.match(store, /const SUBAGENT_POLL_MS = 5_000/)
  assert.match(store, /void get\(\)\.refreshFiles\(sessionId\)\n\s*void get\(\)\.refreshSubagents\(sessionId\)/)
  assert.match(store, /const wanted = sessionId && state\.connected && state\.activeSessionIds\.has\(sessionId\) \? sessionId : null/)
  assert.match(store, /if \(ended === sessionId\) void state\.refreshSubagents\(ended\)/)
  assert.match(store, /if \(NativeAppState\.currentState === 'active'\) void useAppStore\.getState\(\)\.refreshSubagents\(wanted\)/)
  // No overlapping requests: a pending refresh is returned, not duplicated.
  assert.match(store, /const inFlight = subagentsRefreshInFlight\.get\(sessionId\)\n\s*if \(inFlight\) return inFlight/)
})

test('the strip appends the running count and names; rows spin while active and fold into a summary after the turn', () => {
  assert.match(lib, /` · \$\{count\} \$\{count === 1 \? 'subagent' : 'subagents'\} running \(\$\{activeSubagentNames\.slice\(0, 2\)\.join\(', '\)\}\)`/)
  assert.match(bar, /runActivityLabel\(activity, active, now, subagents\.filter\(isSubagentActive\)\.map\(subagentDisplayName\)\)/)
  assert.match(bar, /\.filter\(agent => agent\.runId === runId\)/, 'only the latest turn\'s subagents are listed')
  assert.match(bar, /\{subagents\.length \? <SubagentRows agents=\{subagents\} now=\{now\} runLive=\{label\.live\} \/> : null\}/)
  assert.match(rows, /\{active \? <ActivityIndicator size="small" color=\{colors\.blue\} \/>/)
  assert.match(rows, /agent\.status === 'completed' \? <Check /)
  assert.match(rows, /agent\.status === 'failed' \? <X /)
  assert.match(rows, /const detail = active \? agent\.latestActivity : agent\.summary \|\| agent\.latestActivity/)
  assert.match(rows, /const LOG_PREVIEW_LINES = 20/)
  assert.match(rows, /`Show all \$\{logLines\.length\} lines`/)
  assert.match(rows, /else if \(!runLive\) setOpen\(false\)/, 'the list folds only when the turn itself is over')
  assert.match(rows, /`\$\{agents\.length\} \$\{agents\.length === 1 \? 'subagent' : 'subagents'\}`/)
  assert.match(rows, /`\$\{counts\.get\(status\)\} \$\{subagentStatusLabel\(status\)\}`/)
})
