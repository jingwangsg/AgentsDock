import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const source = relativePath => fs.readFileSync(path.resolve(relativePath), 'utf8')
const composer = source('src/components/Composer.tsx')
const timelineRows = source('src/components/TimelineRows.tsx')
const copyButton = source('src/components/CopyTextButton.tsx')

test('a queued message shows its images, not only its text', () => {
  assert.match(composer, /\{turn\.file_ids\.length \? <View style=\{styles\.queueAttachments\}>\{turn\.file_ids\.map\(fileId => <QueuedAttachment key=\{fileId\} sessionId=\{sessionId\} fileId=\{fileId\} \/>\)\}<\/View> : null\}/)
  // Another device never saw the upload: an unknown file tries the image and falls back to its name.
  assert.match(composer, /if \(!failed && \(!known\?\.content_type \|\| known\.content_type\.startsWith\('image\/'\)\)\) \{/)
  assert.match(composer, /source=\{\{ uri: client\.fileURL\(sessionId, fileId\), headers: client\.authHeaders\(\) \}\}/)
  assert.match(composer, /onError=\{\(\) => setFailed\(true\)\}/)
})

test('tool text in an expanded trace can be copied like a code block', () => {
  assert.match(timelineRows, /<CopyTextButton text=\{text\} label="Copy" testID="trace-text-copy" \/>/)
  assert.match(copyButton, /void Clipboard\.setStringAsync\(text\)\.then\(\(\) => \{\n\s*setCopied\(true\)/)
})
