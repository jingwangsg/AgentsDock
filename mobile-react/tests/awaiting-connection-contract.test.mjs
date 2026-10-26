import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

// These screens do not render under the component harness; the folder picker and Cursor
// notice are rendered in awaiting-connection-notices.test.tsx.
const source = file => fs.readFileSync(path.resolve('src/components', file), 'utf8')

test('without a health report, the job dialog, Agent jobs hint and composer warnings show the connection notice instead of the update message', () => {
  for (const [file, guardedMessages] of [
    ['Dialogs.tsx', [
      /: connectionNotice \?\? \(chatReferences\.length\s*\? 'Stored @Chat routes are view-only/,
      /setStatus\(connectionNotice \?\? 'This server does not advertise scheduled @Chat routes\./,
    ]],
    ['Inspector.tsx', [/: connectionNotice \?\? 'Update AgentsServer to set Read-only or Blocked\./]],
    ['Composer.tsx', [
      /warning=\{!referencesSupported \? connectionNotice \?\? 'This server cannot deliver/,
      /warning=\{!rowReferences\.every\(referenceSupported\) \? connectionNotice \?\? 'Change this action or target before saving\.'/,
      /accessibilityHint=\{!canSkip \? connectionNotice \?\? 'Update AgentsServer to safely remove this delivery\.'/,
    ]],
  ]) {
    const component = source(file)
    assert.match(component, /const connectionNotice = useAppStore\(selectConnectionNotice\)/, file)
    for (const message of guardedMessages) assert.match(component, message, file)
  }
})
