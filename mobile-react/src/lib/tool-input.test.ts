import { readableToolInput, readableValue } from './tool-input'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(readableToolInput('Bash', { command: 'ls -la', description: 'List files', timeout: 600000 }) === 'List files\n$ ls -la\ntimeout: 600000', 'Bash shows its command under the description')
assert(readableToolInput('Bash', { command: 'pwd', workdir: '/tmp' }) === '$ pwd\nworkdir: /tmp', 'Codex Bash keeps its workdir as a line')
assert(readableToolInput('exec', { command: 'pwd', timeout_ms: 10000 }) === '$ pwd\ntimeout_ms: 10000', 'older exec rows are shell commands too')
assert(readableToolInput('Read', { file_path: '/a/b.ts', offset: 10, limit: 20 }) === '/a/b.ts (lines 10-29)', 'Read shows path and line range')
assert(readableToolInput('Read', { file_path: '/a/b.ts' }) === '/a/b.ts', 'Read without a range shows the path alone')
assert(readableToolInput('Edit', { file_path: 'x.py', old_string: 'a\nb', new_string: 'c', replace_all: true }) === 'x.py (replace all)\n- a\n- b\n+ c', 'Edit shows removed and added lines')
assert(readableToolInput('Write', { file_path: 'n.md', content: '# Title\nbody' }) === 'n.md\n\n# Title\nbody', 'Write shows path then content')
assert(
  readableToolInput('apply_patch', { changes: [{ path: 'a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-x\n+y\n' }] }) === '*** Update File: a.ts\n@@ -1 +1 @@\n-x\n+y',
  'apply_patch shows the patch heading',
)
assert(
  readableToolInput('mcp__server__run', { helper: 'publish', arguments: ['--help'], stdin: 'line 1\nline 2' }) === 'helper: publish\narguments:\n  - --help\nstdin:\n  line 1\n  line 2',
  'other tools list fields per line',
)
assert(readableToolInput('Tool', 'raw text') === 'raw text', 'string input stays as written')
assert(readableToolInput('Tool', {}) === '{}', 'an empty object stays JSON')
assert(
  readableValue({ items: [{ id: 1, tags: ['a', 'b'], meta: {} }, { id: 2, note: 'line 1\nline 2' }], ok: true, missing: null })
    === 'items:\n  - id: 1\n    tags:\n      - a\n      - b\n    meta: {}\n  - id: 2\n    note:\n      line 1\n      line 2\nok: true\nmissing: null',
  'nested values read as indented key: value lines',
)
console.log('tool input rendering passed')
