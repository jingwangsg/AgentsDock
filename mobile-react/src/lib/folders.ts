// Nested folders. A folder's name is its path: "Work/Papers" is the folder "Papers" in "Work". The server keeps
// names only (a chat's folder, the folder order), so nesting needs nothing from it, and an app from before nesting
// lists "Work/Papers" as one folder of that name. The desktop app has the same functions
// (electron/src/shared/folders.ts): keep the two in step.

/** The names along a folder's path, outermost first. */
export function folderSegments(folder: string): string[] {
  return folder.split('/').map(segment => segment.trim()).filter(Boolean)
}

/** The path of the folder that `folder` lies in; null for a folder at the top. */
export function folderParent(folder: string): string | null {
  const segments = folderSegments(folder)
  return segments.length > 1 ? segments.slice(0, -1).join('/') : null
}

/** A folder's own name, the last one of its path. */
export function folderLeaf(folder: string): string {
  return folderSegments(folder).at(-1) ?? folder
}

/** Whether `folder` is `ancestor` or lies in it, at any depth. */
export function folderIsWithin(folder: string, ancestor: string): boolean {
  const outer = folderSegments(ancestor)
  const inner = folderSegments(folder)
  if (!outer.length) return folder === ancestor
  return outer.length <= inner.length && outer.every((segment, index) => segment === inner[index])
}

/** `name` as a folder in `parent`, or at the top for null. */
export function folderIn(parent: string | null, name: string): string {
  return [...(parent === null ? [] : folderSegments(parent)), ...folderSegments(name)].join('/')
}

/** The new path of `folder`, which is `from` or lies in it, once `from` has become `to`. */
export function movedFolder(folder: string, from: string, to: string): string {
  return [...folderSegments(to), ...folderSegments(folder).slice(folderSegments(from).length)].join('/')
}

/** Whether `folder` lies in a collapsed folder, which hides it together with its chats. */
export function folderIsHidden(folder: string, collapsed: Iterable<string>): boolean {
  for (const candidate of collapsed) {
    if (candidate !== folder && folderIsWithin(folder, candidate)) return true
  }
  return false
}

/**
 * `folders` in display order: each folder directly before its subfolders. A folder that only its subfolders name
 * ("Work" when the list has "Work/Papers" alone) is added. Folders of one parent keep the order in which the list
 * first names them or one of their subfolders.
 */
export function folderTree(folders: readonly string[]): string[] {
  const named = new Map<string, string>()
  for (const folder of folders) {
    const path = folderSegments(folder).join('/')
    if (!named.has(path)) named.set(path, folder)
  }
  const children = new Map<string | null, string[]>()
  const placed = new Set<string>()
  const place = (folder: string): void => {
    if (placed.has(folder)) return
    placed.add(folder)
    const parentPath = folderParent(folder)
    const parent = parentPath === null ? null : named.get(parentPath) ?? parentPath
    if (parent !== null) place(parent)
    children.set(parent, [...(children.get(parent) ?? []), folder])
  }
  for (const folder of folders) place(folder)
  const ordered: string[] = []
  const walk = (parent: string | null): void => {
    for (const folder of children.get(parent) ?? []) {
      ordered.push(folder)
      walk(folder)
    }
  }
  walk(null)
  return ordered
}

/**
 * `folders` after `from` and its subfolders have become `to`: in their place when `to` has the same parent (a
 * rename), else last in the new parent.
 */
export function folderOrderAfterMove(folders: readonly string[], from: string, to: string): string[] {
  const renamed = folders.map(folder => folderIsWithin(folder, from) ? movedFolder(folder, from, to) : folder)
  const parent = folderParent(to)
  if (parent === folderParent(from)) return renamed
  const moving = renamed.filter(folder => folderIsWithin(folder, to))
  const rest = renamed.filter(folder => !folderIsWithin(folder, to))
  let index = rest.length
  if (parent !== null) {
    const last = rest.map(folder => folderIsWithin(folder, parent)).lastIndexOf(true)
    if (last >= 0) index = last + 1
  }
  rest.splice(index, 0, ...moving)
  return rest
}

/**
 * `folders`, in display order, with `active` and its subfolders moved before or after `target` and its subfolders.
 * Returns the same array when nothing moves: the two must lie in the same folder.
 */
export function reorderFolderList(folders: string[], active: string, target: string, placement: 'before' | 'after'): string[] {
  if (active === target || !folders.includes(active) || !folders.includes(target) || folderParent(active) !== folderParent(target)) return folders
  const moving = folders.filter(folder => folderIsWithin(folder, active))
  const reordered = folders.filter(folder => !folderIsWithin(folder, active))
  let index = reordered.indexOf(target)
  if (placement === 'after') {
    index += 1
    while (index < reordered.length && folderIsWithin(reordered[index], target)) index += 1
  }
  reordered.splice(index, 0, ...moving)
  return reordered
}
