import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const source = fs.readFileSync(path.resolve('src/components/CodeReview.tsx'), 'utf8')

test('code review retries its canonical bounded diff when the connection becomes ready', () => {
  assert.match(source, /interface ScopedCodeReviewProps[^]*?connectionReady: boolean/)
  assert.match(source, /<ScopedCodeReview[^]*?connectionReady=\{connectionReady\}/)
  assert.match(source, /if \(!runId \|\| !connectionReady\) return/)
  assert.match(source, /\[activeProfileId, connection, connectionReady, profileGeneration, runId, sessionId\]/)
})

test('code review renders only the bounded client result and discloses truncation', () => {
  assert.match(source, /const limited = limitReviewSource\(value\.text\)/)
  assert.match(source, /setTruncated\(value\.truncated \|\| limited\.truncated\)/)
  assert.match(source, /mobile is showing a bounded preview/)
})

test('code review lists changed files as a collapsible directory tree', () => {
  assert.match(source, /import \{ buildFileTree, [^}]*\} from '\.\.\/lib\/file-tree'/)
  assert.match(source, /const tree = useMemo\(\(\) => buildFileTree\(files\.map\(file => file\.path\)\), \[files\]\)/)
  // Every directory row is a toggle that exposes its expanded state, and its children render only while expanded.
  assert.match(source, /<Pressable accessibilityRole="button"[^\n]*accessibilityState=\{\{ expanded \}\}[^\n]*onPress=\{\(\) => onToggle\(node\.path\)\}/)
  assert.match(source, /\{expanded \? <ReviewTree nodes=\{node\.children\} depth=\{depth \+ 1\}/)
  // Directories start expanded and reset together with the selected file when the review changes.
  assert.match(source, /useState<ReadonlySet<string>>\(new Set\(\)\)/)
  assert.match(source, /setSelected\(0\)\n\s*setCollapsed\(new Set\(\)\)/)
  // File rows show the leaf name but keep the full path in the accessibility label.
  assert.match(source, /accessibilityLabel=\{`Review \$\{file\.path\}\$\{conflict\}`\}[\s\S]*?numberOfLines=\{2\}>\{name\}<\/Text>/)
})
