export interface FileTreeFile {
  kind: 'file'
  name: string
  /** The caller's original string, so per-file data keyed by path still attaches. */
  path: string
  /** Position in the input array. */
  index: number
}

export interface FileTreeDirectory {
  kind: 'directory'
  /** Display name; a folded chain reads `src/renderer/src/components`. */
  name: string
  path: string
  children: FileTreeNode[]
}

export type FileTreeNode = FileTreeFile | FileTreeDirectory

/**
 * Groups a list of file paths into a directory tree. Directories sort before
 * files, both alphabetically; a directory holding nothing but one subdirectory
 * folds into it so deep single-child chains take one row instead of many.
 */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  interface Draft { directories: Map<string, Draft>; files: FileTreeFile[] }
  const root: Draft = { directories: new Map(), files: [] }
  paths.forEach((original, index) => {
    const segments = original.replace(/\\/g, '/').split('/').filter(Boolean)
    const name = segments.pop() ?? original
    let node = root
    for (const segment of segments) {
      let child = node.directories.get(segment)
      if (!child) {
        child = { directories: new Map(), files: [] }
        node.directories.set(segment, child)
      }
      node = child
    }
    node.files.push({ kind: 'file', name, path: original, index })
  })
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  const finish = (draft: Draft, parentPath: string): FileTreeNode[] => {
    const directories: FileTreeDirectory[] = []
    for (const [segment, child] of draft.directories) {
      let name = segment
      let current = child
      while (current.files.length === 0 && current.directories.size === 1) {
        const [[next, grandchild]] = current.directories
        name = `${name}/${next}`
        current = grandchild
      }
      const path = parentPath ? `${parentPath}/${name}` : name
      directories.push({ kind: 'directory', name, path, children: finish(current, path) })
    }
    return [...directories.sort(byName), ...draft.files.sort(byName)]
  }
  return finish(root, '')
}
