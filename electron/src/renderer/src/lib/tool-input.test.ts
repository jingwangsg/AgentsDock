import { describe, expect, it } from 'vitest'
import { readableToolInput, readableValue } from './tool-input'

describe('readableToolInput', () => {
  it('shows a Bash command under its description and keeps other fields as lines', () => {
    expect(readableToolInput('Bash', { command: 'ls -la', description: 'List files', timeout: 600000 }))
      .toBe('List files\n$ ls -la\ntimeout: 600000')
    expect(readableToolInput('Bash', { command: 'pwd', workdir: '/tmp' })).toBe('$ pwd\nworkdir: /tmp')
    expect(readableToolInput('exec', { command: 'pwd', timeout_ms: 10000 })).toBe('$ pwd\ntimeout_ms: 10000')
  })

  it('shows a Read as its path and line range', () => {
    expect(readableToolInput('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(readableToolInput('Read', { file_path: '/a/b.ts', offset: 10, limit: 20 })).toBe('/a/b.ts (lines 10-29)')
    expect(readableToolInput('Read', { file_path: '/a/b.ts', limit: 5 })).toBe('/a/b.ts (first 5 lines)')
  })

  it('shows an Edit as removed and added lines', () => {
    expect(readableToolInput('Edit', { file_path: 'x.py', old_string: 'a\nb', new_string: 'c', replace_all: true }))
      .toBe('x.py (replace all)\n- a\n- b\n+ c')
    expect(readableToolInput('Edit', { file_path: 'x.py', old_string: '', new_string: 'new' })).toBe('x.py\n+ new')
  })

  it('shows a Write as its path followed by the content', () => {
    expect(readableToolInput('Write', { file_path: 'n.md', content: '# Title\nbody' })).toBe('n.md\n\n# Title\nbody')
  })

  it('shows Codex apply_patch changes with the patch heading', () => {
    expect(readableToolInput('apply_patch', { changes: [
      { path: 'a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-x\n+y\n' },
      { path: 'b.ts', kind: { type: 'add' }, diff: 'new\n' }
    ] })).toBe('*** Update File: a.ts\n@@ -1 +1 @@\n-x\n+y\n\n*** Add File: b.ts\nnew')
  })

  it('renders nested values as indented key: value lines', () => {
    expect(readableValue({ items: [{ id: 1, tags: ['a', 'b'], meta: {} }, { id: 2, note: 'line 1\nline 2' }], ok: true, missing: null }))
      .toBe('items:\n  - id: 1\n    tags:\n      - a\n      - b\n    meta: {}\n  - id: 2\n    note:\n      line 1\n      line 2\nok: true\nmissing: null')
  })

  it('lists any other tool field per line, indenting multi-line and large values', () => {
    expect(readableToolInput('mcp__server__run', { helper: 'publish', arguments: ['--help'], stdin: 'line 1\nline 2' }))
      .toBe('helper: publish\narguments:\n  - --help\nstdin:\n  line 1\n  line 2')
    expect(readableToolInput('Grep', { pattern: 'foo', path: 'src', '-n': true })).toBe('pattern: foo\npath: src\n-n: true')
  })

  it('leaves strings, arrays and empty objects as they are', () => {
    expect(readableToolInput('Tool', 'raw text')).toBe('raw text')
    expect(readableToolInput('Tool', [1, 2])).toBe('- 1\n- 2')
    expect(readableToolInput('Tool', {})).toBe('{}')
  })
})
