import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// These screens do not render under the component harness; the folder picker and Cursor
// notice are rendered in awaiting-connection-notices.test.tsx.
const source = file => fs.readFileSync(path.resolve('src/components', file), 'utf8')

test('without a health report, server-update messages give way to the connection notice', () => {
  for (const [file, guardedMessage] of [
    ['Dialogs.tsx', /: awaitingConnection \?\? \(chatReferences\.length\s*\? 'Stored @Chat routes are view-only/],
    ['Inspector.tsx', /: awaitingConnection \?\? 'Update AgentsServer to set Read-only or Blocked\./],
    ['Composer.tsx', /accessibilityHint=\{!canSkip \? awaitingConnection \?\? 'Update AgentsServer to safely remove this delivery\.'/],
  ]) {
    const component = source(file)
    assert.match(component, /const awaitingConnection = useAppStore\(awaitingConnectionNotice\)/, file)
    assert.match(component, guardedMessage, file)
  }
})
