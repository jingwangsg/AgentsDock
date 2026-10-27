import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const dialogs = fs.readFileSync(path.resolve('src/components/Dialogs.tsx'), 'utf8')

function sourceBetween(startToken, endToken, from = 0) {
  const start = dialogs.indexOf(startToken, from)
  assert.notEqual(start, -1, `missing scheduler source token: ${startToken}`)
  const end = dialogs.indexOf(endToken, start + startToken.length)
  assert.notEqual(end, -1, `missing scheduler source token: ${endToken}`)
  return dialogs.slice(start, end)
}

const picker = sourceBetween('testID="job-start-picker"', 'testID="job-start-value"')

test('both platforms show Android\'s date and time buttons, each opening a Material dialog', () => {
  assert.match(picker, /testID="job-start-date-button"[^]*?setAndroidStartPicker\('date'\)/)
  assert.match(picker, /testID="job-start-time-button"[^]*?setAndroidStartPicker\('time'\)/)
  // No inline SwiftUI pickers on iOS: the dialogs come from material/DateTimePickerDialog, which is
  // @expo/ui's Compose dialog on Android and the app-drawn copy on iOS.
  assert.doesNotMatch(dialogs, /compactIOSPicker|display="compact"|@expo\/ui\/community\/datetime-picker/)
  assert.match(dialogs, /import \{ DateTimePicker \} from '\.\/material\/DateTimePickerDialog'/)
  assert.match(dialogs, /\{androidStartPicker \? <DateTimePicker/)
  assert.match(dialogs, /mode=\{androidStartPicker\}[^]*?presentation="dialog"[^]*?display="default"/)
  assert.match(dialogs, /mergeScheduleWallTimePickerValue\(startRef\.current, value, part, part === 'date'\)[^]*?setAndroidStartPicker\(null\)/)
  assert.match(dialogs, /onDismiss=\{\(\) => setAndroidStartPicker\(null\)\}/)
})

test('all scheduled-job modes, picker updates, and save remain wired', () => {
  for (const mode of ['keep', 'immediate', 'interval', 'time']) {
    assert.match(
      dialogs,
      new RegExp(`testID="job-start-mode-${mode}"[^>]*onPress=\\{\\(\\) => selectStartMode\\('${mode}'\\)\\}`),
      `${mode} start mode must retain its activation handler`,
    )
  }
  assert.match(dialogs, /\(\['interval', 'cron', 'rrule'\] as JobScheduleKind\[\]\)\.map/)
  assert.match(dialogs, /testID=\{`job-schedule-kind-\$\{value\}`\}[^>]*onPress=\{\(\) => setScheduleKind\(value\)\}/)
  assert.match(dialogs, /selected=\{!loop\} onPress=\{\(\) => setLoop\(false\)\}/)
  assert.match(dialogs, /selected=\{loop\} onPress=\{\(\) => setLoop\(true\)\}/)
  assert.match(dialogs, /<Switch accessibilityLabel="Job enabled" value=\{enabled\} onValueChange=\{setEnabled\}/)
  assert.match(dialogs, /if \(value !== 'keep'\) setEnabled\(true\)/)
  assert.match(dialogs, /updateStart\(defaultScheduleWallTime\(new Date\(\), scheduleKind, timezone\)\)/)
  assert.match(dialogs, /const startError = validateJobNextRun\(Boolean\(job\), startMode, start, scheduleKind, enabled\)/)
  assert.match(dialogs, /if \(startError\) \{ setStatus\(startError\); return \}/)
  assert.match(dialogs, /Object\.assign\(patch, jobNextRunUpdatePatch\(\{/)
  assert.match(dialogs, /testID="job-save"[^>]*disabled=\{saving \|\| !title\.trim\(\) \|\| !prompt\.trim\(\) \|\| Boolean\(scheduleError\) \|\| Boolean\(startError\)\}[^>]*onPress=\{\(\) => void submit\(\)\}/)
})
