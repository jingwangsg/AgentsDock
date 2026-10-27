import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

const markdown = await readFile(resolve('src/components/MarkdownContent.tsx'), 'utf8')
const markdownStyle = await readFile(resolve('src/lib/markdown.ts'), 'utf8')
const timelineRows = await readFile(resolve('src/components/TimelineRows.tsx'), 'utf8')
const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
const lockfile = await readFile(resolve('pnpm-lock.yaml'), 'utf8')

test('timeline Markdown uses a pinned native UITextView range-selection surface', () => {
  assert.equal(packageJson.dependencies['@bsky.app/react-native-uitextview'], '2.7.0')
  assert.match(lockfile, /'@bsky\.app\/react-native-uitextview@2\.7\.0':/)
  assert.match(markdown, /UITextView as SelectableText/)
  assert.match(markdown, /textgroup:[\s\S]*?<SelectableText key=\{node\.key\} selectable uiTextView style=\{styles\.textgroup\}>/)
  // Code blocks keep the range-selection surface inside the frame that carries their copy button.
  assert.match(markdown, /code_block:[\s\S]*?<CodeFrame key=\{node\.key\} code=\{code\}>\n\s*<SelectableText selectable uiTextView style=\{\[inheritedStyles, styles\.code_block, codeFrameStyles\.text\]\}>/)
  assert.match(markdown, /fence:[\s\S]*?<CodeFrame key=\{node\.key\} code=\{code\}><SelectableText selectable uiTextView style=\{\[inheritedStyles, styles\.fence, codeFrameStyles\.text\]\}>/)
  assert.match(markdown, /<CopyTextButton text=\{code\} label="Copy code" testID="markdown-code-copy" \/>/)
  assert.match(markdown, /strong:[\s\S]*?<SelectableText/)
  assert.match(markdown, /link:[\s\S]*?const href = String\(node\.attributes\.href \?\? ''\)[\s\S]*?<SelectableText[\s\S]*?onPress=\{\(\) => openLink\(href\)\}/)
  assert.match(markdown, /code_inline:[\s\S]*?<SelectableText/)
})

test('a selectable paragraph keeps its last line when its float frame is a hair under the measured height', async () => {
  // A 3-line bullet laid out 68.9998779 pt tall for 69 pt of text lost its third line and ended in "…".
  const workspace = await readFile(resolve('pnpm-workspace.yaml'), 'utf8')
  const patch = await readFile(resolve('patches/@bsky.app__react-native-uitextview@2.7.0.patch'), 'utf8')
  assert.match(workspace, /'@bsky\.app\/react-native-uitextview@2\.7\.0': patches\/@bsky\.app__react-native-uitextview@2\.7\.0\.patch/)
  assert.match(patch, /\+  frame\.size\.height = ceil\(frame\.size\.height \* scale - 0\.01\) \/ scale;/)
  assert.match(patch, /\+  frame\.size\.width = ceil\(frame\.size\.width \* scale - 0\.01\) \/ scale;/)
  assert.match(patch, /\+    _textView\.frame = textViewFrame;/)
  // The redraw check compares against the same rounded frame, or every redraw would reassign it and clear a selection.
  assert.match(patch, /\+  const BOOL frameChanged = !CGRectEqualToRect\(_textView\.frame, textViewFrame\);/)
  assert.match(patch, /\+  if \(!CGRectEqualToRect\(_textView\.frame, \[self textViewFrame\]\)\) \{/)
})

test('indented Markdown keeps selectable text inside the measured list slot', () => {
  assert.match(markdownStyle, /list_item: \{[^}]*minWidth: 0[^}]*width: '100%'/)
  assert.match(markdownStyle, /ordered_list_content: \{[^}]*flex: 1[^}]*flexShrink: 1[^}]*minWidth: 0/)
  assert.match(markdownStyle, /bullet_list_content: \{[^}]*flex: 1[^}]*flexShrink: 1[^}]*minWidth: 0/)
  assert.match(markdownStyle, /textgroup: \{[^}]*flexShrink: 1[^}]*minWidth: 0[^}]*maxWidth: '100%'[^}]*width: '100%'/)
})

test('inline native attachments retain the existing Markdown renderer', () => {
  assert.match(markdown, /containsInlineAttachment\(node\)/)
  assert.match(markdown, /node\.type === 'math_inline' \|\| node\.type === 'image'/)
  // Selectable everywhere but Android, where only non-selectable Text draws the layout its attachments were placed on.
  assert.match(markdown, /return <NativeText key=\{node\.key\} selectable=\{Platform\.OS !== 'android'\} style=\{styles\.textgroup\}>/)
  assert.match(markdown, /if \(!rendered\) return <NativeText selectable/)
  assert.match(markdown, /rules=\{markdownRules\}/)
})

test('timeline messages retain an explicit full-message copy action', () => {
  const messageRow = timelineRows.slice(
    timelineRows.indexOf('function MessageRowView'),
    timelineRows.indexOf('function mergeTraceEvents'),
  )
  assert.match(timelineRows, /await Clipboard\.setStringAsync\(full\)/)
  assert.match(timelineRows, /label="Copy full text"/)
  assert.match(timelineRows, /announceForAccessibility\('Copied full message'\)/)
  assert.doesNotMatch(messageRow, /onLongPress/, 'card gestures must not compete with native selection')
})
