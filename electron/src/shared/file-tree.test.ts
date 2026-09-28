import { describe, expect, it } from 'vitest'
import { buildFileTree, type FileTreeNode } from './file-tree'

// Compact `name` / `name/` outline so the expected shape is readable at a glance.
const outline = (nodes: FileTreeNode[], depth = 0): string[] => nodes.flatMap(node => node.kind === 'directory'
  ? [`${'  '.repeat(depth)}${node.name}/`, ...outline(node.children, depth + 1)]
  : [`${'  '.repeat(depth)}${node.name}`])

describe('buildFileTree', () => {
  it('nests files under their directories and keeps root-level files at the root', () => {
    expect(outline(buildFileTree(['README.md', 'src/main.ts', 'src/lib/util.ts']))).toEqual([
      'src/',
      '  lib/',
      '    util.ts',
      '  main.ts',
      'README.md'
    ])
  })

  it('folds single-child directory chains into one node', () => {
    const tree = buildFileTree(['src/renderer/src/components/A.tsx', 'src/renderer/src/components/B.tsx', 'src/shared/x.ts'])
    expect(outline(tree)).toEqual([
      'src/',
      '  renderer/src/components/',
      '    A.tsx',
      '    B.tsx',
      '  shared/',
      '    x.ts'
    ])
    const src = tree[0] as Extract<FileTreeNode, { kind: 'directory' }>
    expect(src.children[0]).toMatchObject({ kind: 'directory', name: 'renderer/src/components', path: 'src/renderer/src/components' })
  })

  it('does not fold a directory that holds a file of its own', () => {
    expect(outline(buildFileTree(['a/b/c.ts', 'a/d.ts']))).toEqual(['a/', '  b/', '    c.ts', '  d.ts'])
  })

  it('sorts directories before files, both alphabetically', () => {
    expect(outline(buildFileTree(['z.ts', 'b/one.ts', 'a.ts', 'a/two.ts', 'b/alpha.ts']))).toEqual([
      'a/',
      '  two.ts',
      'b/',
      '  alpha.ts',
      '  one.ts',
      'a.ts',
      'z.ts'
    ])
  })

  it('keeps the original path and input index on every file node', () => {
    const tree = buildFileTree(['src\\win\\file.ts', 'src//dup//x.ts', 'src/win/file.ts'])
    const files: Array<{ path: string; index: number }> = []
    const visit = (nodes: FileTreeNode[]) => nodes.forEach(node => node.kind === 'file' ? files.push({ path: node.path, index: node.index }) : visit(node.children))
    visit(tree)
    expect(outline(tree)).toEqual(['src/', '  dup/', '    x.ts', '  win/', '    file.ts', '    file.ts'])
    expect(files).toEqual([
      { path: 'src//dup//x.ts', index: 1 },
      { path: 'src\\win\\file.ts', index: 0 },
      { path: 'src/win/file.ts', index: 2 }
    ])
  })

  it('returns an empty tree for no paths', () => {
    expect(buildFileTree([])).toEqual([])
  })
})
