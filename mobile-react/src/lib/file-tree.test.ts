import assert from 'node:assert/strict'
import { buildFileTree, type FileTreeNode } from './file-tree'

// Compact `name` / `name/` outline so the expected shape is readable at a glance.
const outline = (nodes: FileTreeNode[], depth = 0): string[] => nodes.flatMap(node => node.kind === 'directory'
  ? [`${'  '.repeat(depth)}${node.name}/`, ...outline(node.children, depth + 1)]
  : [`${'  '.repeat(depth)}${node.name}`])

// Nesting, with root-level files kept at the root.
assert.deepEqual(outline(buildFileTree(['README.md', 'src/main.ts', 'src/lib/util.ts'])), [
  'src/',
  '  lib/',
  '    util.ts',
  '  main.ts',
  'README.md',
])

// Single-child directory chains fold into one node that keeps the full path.
{
  const tree = buildFileTree(['src/renderer/src/components/A.tsx', 'src/renderer/src/components/B.tsx', 'src/shared/x.ts'])
  assert.deepEqual(outline(tree), [
    'src/',
    '  renderer/src/components/',
    '    A.tsx',
    '    B.tsx',
    '  shared/',
    '    x.ts',
  ])
  const src = tree[0]
  assert.equal(src.kind, 'directory')
  if (src.kind === 'directory') {
    assert.deepEqual({ name: src.children[0].name, path: src.children[0].path }, { name: 'renderer/src/components', path: 'src/renderer/src/components' })
  }
}

// A directory holding a file of its own does not fold.
assert.deepEqual(outline(buildFileTree(['a/b/c.ts', 'a/d.ts'])), ['a/', '  b/', '    c.ts', '  d.ts'])

// Directories sort before files, both alphabetically.
assert.deepEqual(outline(buildFileTree(['z.ts', 'b/one.ts', 'a.ts', 'a/two.ts', 'b/alpha.ts'])), [
  'a/',
  '  two.ts',
  'b/',
  '  alpha.ts',
  '  one.ts',
  'a.ts',
  'z.ts',
])

// Windows separators and duplicate slashes normalise; file nodes keep the original path and index.
{
  const tree = buildFileTree(['src\\win\\file.ts', 'src//dup//x.ts', 'src/win/file.ts'])
  const files: Array<{ path: string; index: number }> = []
  const visit = (nodes: FileTreeNode[]): void => nodes.forEach(node => node.kind === 'file' ? files.push({ path: node.path, index: node.index }) : visit(node.children))
  visit(tree)
  assert.deepEqual(outline(tree), ['src/', '  dup/', '    x.ts', '  win/', '    file.ts', '    file.ts'])
  assert.deepEqual(files, [
    { path: 'src//dup//x.ts', index: 1 },
    { path: 'src\\win\\file.ts', index: 0 },
    { path: 'src/win/file.ts', index: 2 },
  ])
}

assert.deepEqual(buildFileTree([]), [])

console.log('file-tree tests passed')
