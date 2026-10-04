import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const read = file => fs.readFileSync(path.resolve(file), 'utf8')

test('the Claude goal editor prefills the current condition and can replace a running goal by stopping it first', () => {
  const composer = read('src/components/Composer.tsx')
  assert.match(composer, /initialValue: goal\?\.status === 'active' \? goal\.condition : ''/)
  assert.match(composer, /confirmLabel: busy \? 'Stop & set goal' : 'Set goal'/)
  assert.match(composer, /setGoalFromCommand\(value\.trim\(\), \{ stopFirst: busy \}\)/)
  // Stop first, wait until the server reports the chat idle, then start the edited condition.
  assert.match(composer, /if \(stopFirst && !clearing\) \{[\s\S]{0,400}connection\.clearClaudeGoal\(id\)\)[\s\S]{0,600}claudeRuntime\.refresh\(\)\)\?\.status\?\.type !== 'active'/)
  assert.match(composer, /Claude is still stopping\. Set the goal again in a moment\./)
  const bar = read('src/components/ClaudeGoalBar.tsx')
  assert.match(bar, /testID="claude-goal-edit"[^\n]*disabled=\{mutating\} onPress=\{onEdit\}/)
})
