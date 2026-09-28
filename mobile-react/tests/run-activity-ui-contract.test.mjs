import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const chatScreen = source('src/components/ChatScreen.tsx')
const bar = source('src/components/RunActivityBar.tsx')
const lib = source('src/lib/run-activity.ts')

test('the running state is pinned under the timeline, above the shelves and composer', () => {
  assert.match(chatScreen, /\{!welcome \? <RunActivityBar sessionId=\{sessionId\} \/> : null\}/)
  const timelineClose = chatScreen.indexOf('<Timeline sessionId={sessionId}')
  const barIndex = chatScreen.indexOf('<RunActivityBar sessionId={sessionId} />')
  const shelfIndex = chatScreen.indexOf('<CodexInteractionShelf />')
  const composerIndex = chatScreen.indexOf('<Composer sessionId={sessionId}')
  assert.ok(timelineClose < barIndex && barIndex < shelfIndex && shelfIndex < composerIndex)
})

test('a live turn shows a spinner, Working… and a 1 s elapsed counter; a finished turn collapses to Worked for', () => {
  assert.match(bar, /const active = useAppStore\(state => state\.activeSessionIds\.has\(sessionId\)\)/)
  assert.match(bar, /const timer = setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/)
  assert.match(bar, /\{label\.live \? <ActivityIndicator size="small" color=\{colors\.blue\} \/> : null\}/)
  assert.match(bar, /testID="run-activity"/)
  assert.match(bar, /accessibilityLiveRegion="polite"/)
  assert.match(bar, /accessibilityLabel=\{label\.elapsed \? `\$\{label\.title\} \$\{label\.elapsed\}` : label\.title\}/)
  assert.match(lib, /title: `Working…\$\{running\}`/)
  assert.match(lib, /`Worked for \$\{duration\}`/)
  assert.match(lib, /`You stopped after \$\{duration\}`/)
  // The server's active flag, not the event tail, decides live vs collapsed.
  assert.match(lib, /export function runActivityLabel\(activity: RunActivity \| null, active: boolean, now: number, activeSubagentNames: readonly string\[\] = \[\]\)/)
})
