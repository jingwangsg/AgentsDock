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
  const remaining = [...groups.keys()]
    .filter(folder => !['Pinned', 'General', 'Archived'].includes(folder) && !folderOrder.includes(folder))
    .sort((left, right) => left.localeCompare(right))
  const orderedFolders = ['Pinned', ...folderOrder, ...remaining, 'General', ...(includeArchived ? ['Archived'] : [])]
    .filter((folder, index, values) => values.indexOf(folder) === index && (
      // In the unfiltered sidebar General stays listed even when every chat in
      // it is archived or pinned, so Create Folder cannot report it as
      // existing while nothing on screen shows it.
      (includeEmptyFolders && folder === 'General')
      || (groups.get(folder)?.length ?? 0) > 0
      // A folder created in the mobile sidebar exists before any chat is
      // moved into it. Keep those explicit custom folders visible so Create
      // Folder never appears to succeed and then lose the folder.
      || (includeEmptyFolders && !['Pinned', 'General', 'Archived'].includes(folder) && folderOrder.includes(folder))
    ))
  return orderedFolders.map(folder => ({ id: folder, title: folder, sessions: [...(groups.get(folder) ?? [])].sort(compareSessions) }))
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
    if (folder && folder !== 'General' && !known.has(folder)) { known.add(folder); next.push(folder) }
  }
  return next.length === folderOrder.length ? folderOrder : next
}
