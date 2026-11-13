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

/** Folders the sidebar lists, in display order: `folderOrder` first, then folders only live chats know about. */
export function sidebarFolders(sessions: readonly Session[], folderOrder: readonly string[]): string[] {
  const order = new Map(folderOrder.map((folder, index) => [folder, index]))
  const folders = new Set([...folderOrder, ...sessions.filter(session => !session.archived && !session.pinned).map(session => session.folder?.trim() || 'General')])
  return [...folders].sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b))
}
