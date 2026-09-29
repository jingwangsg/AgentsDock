import type { Session } from '../types'

export interface SessionSection {
  id: string
  title: string
  sessions: Session[]
}
export function compareSessions(leftSession: Session, rightSession: Session): number {
  const left = leftSession.sort_order ?? Number.MAX_SAFE_INTEGER
  const right = rightSession.sort_order ?? Number.MAX_SAFE_INTEGER
  if (left !== right) return left - right
  return (leftSession.created_at ?? '').localeCompare(rightSession.created_at ?? '')
}

export function sessionSection(session: Session): string {
  return session.archived ? 'Archived' : session.pinned ? 'Pinned' : session.folder?.trim() || 'General'
}

export function orderedSessionSections(
  sessions: Session[],
  folderOrder: string[],
  includeArchived = true,
  includeEmptyFolders = false,
): SessionSection[] {
  const groups = new Map<string, Session[]>()
  for (const folder of folderOrder) groups.set(folder, [])
  for (const session of sessions) {
    if (!includeArchived && session.archived) continue
    const folder = sessionSection(session)
    groups.set(folder, [...(groups.get(folder) ?? []), session])
  }
  // Map insertion order is folderOrder first, then session folders as first
  // seen, so the unlisted tail is already in display order.
  const remaining = [...groups.keys()]
    .filter(folder => !['Pinned', 'Archived'].includes(folder) && !folderOrder.includes(folder))
  const orderedFolders = ['Pinned', ...folderOrder, ...remaining, ...(includeArchived ? ['Archived'] : [])]
    .filter((folder, index, values) => values.indexOf(folder) === index && (
      (groups.get(folder)?.length ?? 0) > 0
      // A folder created in the mobile sidebar exists before any chat is
      // moved into it, and keeps its place after its last chat is archived.
      // Keep every folderOrder entry visible so Create Folder never appears
      // to succeed and then lose the folder.
      || (includeEmptyFolders && !['Pinned', 'Archived'].includes(folder) && folderOrder.includes(folder))
    ))
  return orderedFolders.map(folder => ({ id: folder, title: folder, sessions: [...(groups.get(folder) ?? [])].sort(compareSessions) }))
}

export type SidebarDropRow = { kind: 'header'; folder: string } | { kind: 'session'; session: Session }

type SidebarDrop =
  | { kind: 'folder-order'; order: string[] }
  | { kind: 'reorder'; sessionId: string; targetId: string; placement: 'before' | 'after'; targetFolder?: string }
  | { kind: 'move'; sessionId: string; folder: string }

/**
 * What dropping a dragged row means, given the list as it looks after the drop
 * (`next`, dragged row at `to`) and `folders`, the current folder order.
 * Same section rules as the server's reorder endpoint: a chat joins the section
 * it lands under, may move into any folder, but never into Pinned or Archived from
 * outside; folder headers reorder folders only. A pinned chat dropped into a folder
 * is unpinned, like Move to Folder here (the desktop keeps it pinned). null means
 * nothing changes.
 */
export function resolveSidebarDrop(next: SidebarDropRow[], to: number, sessions: Session[], folders: string[]): SidebarDrop | null {
  const moved = next[to]
  if (moved.kind === 'header') {
    const order = next.flatMap(row => row.kind === 'header' && !['Pinned', 'Archived'].includes(row.folder) ? [row.folder] : [])
    return order.join('\n') === folders.join('\n') ? null : { kind: 'folder-order', order }
  }
  let index = to - 1
  while (index >= 0 && next[index].kind !== 'header') index -= 1
  const header = next[index]
  if (!header || header.kind !== 'header') return null
  const section = header.folder
  const source = sessionSection(moved.session)
  if (section !== source && ['Pinned', 'Archived'].includes(section)) return null
  const targetFolder = section !== source ? { targetFolder: section } : {}
  const sessionId = moved.session.id
  const previous = next[to - 1]
  if (previous.kind === 'session') return { kind: 'reorder', sessionId, targetId: previous.session.id, placement: 'after', ...targetFolder }
  // Right under a header, shown or collapsed: first in that folder.
  const first = sessions.filter(peer => peer.id !== sessionId && sessionSection(peer) === section).sort(compareSessions)[0]
  if (first) return { kind: 'reorder', sessionId, targetId: first.id, placement: 'before', ...targetFolder }
  return section === source ? null : { kind: 'move', sessionId, folder: section }
}

/**
 * Folders exist only as a session attribute plus the persisted folder order,
 * so a folder whose last chat was archived or deleted would vanish while
 * Create Folder still reported it as existing. Remember every folder a session
 * was ever filed under; only Delete folder removes it. Returns the same array
 * when nothing new was learned.
 */
export function rememberedFolderOrder(folderOrder: string[], sessions: Pick<Session, 'folder'>[]): string[] {
  const known = new Set(folderOrder.map(folder => folder.trim()).filter(Boolean))
  const next = [...known]
  for (const session of sessions) {
    const folder = session.folder?.trim()
    if (folder && !known.has(folder)) { known.add(folder); next.push(folder) }
  }
  return next.length === folderOrder.length ? folderOrder : next
}
