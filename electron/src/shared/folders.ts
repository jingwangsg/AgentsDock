import type { Session } from './types'

/**
 * Folders exist only as a session attribute plus the persisted `folderOrder`
 * preference, so a folder whose last chat was archived or deleted would vanish
 * from the sidebar while "New folder" still reported it as existing. Remember
 * every folder a session was ever filed under; only Delete folder removes it.
 * Returns the same array instance when nothing new was learned.
 */
export function rememberedFolderOrder(folderOrder: readonly string[], sessions: readonly Pick<Session, 'folder'>[]): string[] {
  const known = new Set(folderOrder.map(folder => folder.trim()).filter(Boolean))
  const next = [...known]
  for (const session of sessions) {
    const folder = session.folder?.trim()
    if (folder && !known.has(folder)) { known.add(folder); next.push(folder) }
  }
  return next.length === known.size && next.length === folderOrder.length && next.every((folder, i) => folder === folderOrder[i]) ? [...folderOrder] as string[] : next
}

// Nested folders. A folder's name is its path: "Work/Papers" is the folder "Papers" in "Work". "Papers" is its own
// name and "Work" its parent; "Work" has no parent, it is at the top level. The subfolders of a folder are the
// folders in it at any depth. Spaces around an own name and empty own names do not count: " Work / Papers " and
// "Work//Papers" are the path "Work/Papers". The functions return paths in that spelling; folderTree keeps the
// spelling the list has. The server keeps names only (a chat's folder, a tab's folder, the folder order), so
// nesting needs nothing from it. An app from before nesting lists "Work/Papers" as one folder of that name, and a
// folder that had a "/" in its name before nesting is now listed as nested.
// The phone app has the same functions in mobile-react/src/lib/folders.ts, with reorderFolderList, which is in
// renderer/src/components/Sidebar.tsx here. Keep them in step.

/** The own names along a folder's path, outermost first, trimmed; empty ones are dropped. */
export function folderSegments(folder: string): string[] {
  return folder.split('/').map(segment => segment.trim()).filter(Boolean)
}

/** A folder's path in the spelling the functions here return. */
export function folderPath(folder: string): string {
  return folderSegments(folder).join('/')
}

/** The path of `folder`'s parent; null for a top-level folder. */
export function folderParent(folder: string): string | null {
  const segments = folderSegments(folder)
  return segments.length > 1 ? segments.slice(0, -1).join('/') : null
}

/** A folder's own name: the last name of its path. A name without one ("/") is returned as it is. */
export function folderOwnName(folder: string): string {
  return folderSegments(folder).at(-1) ?? folder
}

/** Whether `folder` is `ancestor` or one of its subfolders. */
export function folderIsWithin(folder: string, ancestor: string): boolean {
  const outer = folderSegments(ancestor)
  const inner = folderSegments(folder)
  // load-bearing: a name without an own name ("/") has an empty path, which every path starts with. Without this
  // every folder would be within it, and deleting or renaming that folder would take all folders.
  if (!outer.length) return folder === ancestor
  return outer.length <= inner.length && outer.every((segment, index) => segment === inner[index])
}

/** The path of the folder `name` in `parent`, or at the top level for null. `name` may be a path: "Papers/2026" in "Work" is "Work/Papers/2026". */
export function folderPathIn(parent: string | null, name: string): string {
  return [...(parent === null ? [] : folderSegments(parent)), ...folderSegments(name)].join('/')
}

/** The path of `folder`, which is `from` or one of its subfolders, once `from` has the path `to`. */
export function renamedFolder(folder: string, from: string, to: string): string {
  return [...folderSegments(to), ...folderSegments(folder).slice(folderSegments(from).length)].join('/')
}

/**
 * `folders` in tree order: every folder once, directly before its subfolders. A parent missing from the list
 * ("Work" when the list has only "Work/Papers") is added. The folders of one parent keep the order in which they,
 * or a subfolder of theirs, first appear in the list.
 */
export function folderTree(folders: readonly string[]): string[] {
  // By path: a listed "Work / Papers" is the parent of "Work/Papers/2026" and is not added again as "Work/Papers".
  const listed = new Map<string, string>()
  for (const folder of folders) {
    if (!listed.has(folderPath(folder))) listed.set(folderPath(folder), folder)
  }
  const children = new Map<string | null, string[]>()
  const placed = new Set<string>()
  const place = (folder: string): void => {
    if (placed.has(folder)) return
    placed.add(folder)
    const parentPath = folderParent(folder)
    const parent = parentPath === null ? null : listed.get(parentPath) ?? parentPath
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
 * `folders` after the folder `from` got the path `to`: it and its subfolders carry their new paths. They keep their
 * place when the parent is the same (only the own name changed); otherwise they go after the last folder of the new
 * parent, or to the end of the list when `to` is at the top level or its parent is not listed.
 */
export function folderOrderAfterRename(folders: readonly string[], from: string, to: string): string[] {
  const renamed = folders.map(folder => folderIsWithin(folder, from) ? renamedFolder(folder, from, to) : folder)
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

/** Folders the sidebar lists, in tree order: `folderOrder` first, then folders only live chats know about. */
export function sidebarFolders(sessions: readonly Session[], folderOrder: readonly string[]): string[] {
  const order = new Map(folderOrder.map((folder, index) => [folder, index]))
  const folders = new Set([...folderOrder, ...sessions.filter(session => !session.archived && !session.pinned).map(session => session.folder?.trim() || 'General')])
  return folderTree([...folders].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b)))
}
