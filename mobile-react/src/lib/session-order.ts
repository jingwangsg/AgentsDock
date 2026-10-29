import type { Session } from '../types'
import { fuzzyScore } from './fuzzy'

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

/**
 * A job run chat is a chat a standalone scheduled job created for one run. The sidebar and its search
 * list it only while it is the open chat, archived or not: a job that runs every minute would otherwise
 * fill the list, or the Archived section when the job archives successful runs. The job card in the
 * chat that scheduled the job opens the latest run's chat, and each entry under Previous runs opens its own.
 */
export function isHiddenRunChat(session: Pick<Session, 'id' | 'scheduled_job_run'>, selectedSessionId: string | null | undefined): boolean {
  return Boolean(session.scheduled_job_run) && session.id !== selectedSessionId
}

export function sidebarVisibleSessions(sessions: Session[], selectedSessionId: string | null | undefined): Session[] {
  return sessions.filter(session => !isHiddenRunChat(session, selectedSessionId))
}

/**
 * Unread chats the sidebar lists outside Archived, so the badges match the list. The open run chat is
 * left out too: opening a chat marks it read, and only a Mark as Unread on it while it stays open goes
 * uncounted.
 */
export function unreadCount(sessions: readonly Session[]): number {
  return sessions.filter(session => !session.archived && !isHiddenRunChat(session, null) && (session.manual_unread || (session.latest_agent_event_seq ?? 0) > (session.last_read_agent_event_seq ?? 0))).length
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

/**
 * Ranks @ picker rows. A title match comes first: exact, then prefix, then
 * substring. Then rows where every space-separated term matches the title or
 * another field as characters in order (best `fuzzyScore` first, a title match
 * counting double); then rows `otherMatch` accepts. Ties keep the given order.
 */
export function rankMentionRows<T>(
  rows: readonly T[],
  query: string,
  fields: (row: T) => readonly [title: string, ...others: Array<string | null | undefined>],
  otherMatch: (row: T) => boolean,
): T[] {
  const needle = query.trim().toLocaleLowerCase()
  const terms = needle.split(/\s+/).filter(Boolean)
  if (!terms.length) return [...rows]
  const ranked: Array<{ row: T; index: number; tier: number; score: number }> = []
  rows.forEach((row, index) => {
    const [title, ...others] = fields(row)
    const lowerTitle = title.toLocaleLowerCase()
    const nameRank = lowerTitle === needle ? 0 : lowerTitle.startsWith(needle) ? 1 : lowerTitle.includes(needle) ? 2 : null
    if (nameRank !== null) {
      ranked.push({ row, index, tier: 0, score: -nameRank })
      return
    }
    const termScores = terms.map(term => Math.max(
      2 * (fuzzyScore(term, title)?.score ?? Number.NEGATIVE_INFINITY),
      ...others.map(text => (text ? fuzzyScore(term, text)?.score : undefined) ?? Number.NEGATIVE_INFINITY),
    ))
    if (termScores.every(Number.isFinite)) ranked.push({ row, index, tier: 1, score: termScores.reduce((sum, score) => sum + score, 0) })
    else if (otherMatch(row)) ranked.push({ row, index, tier: 2, score: 0 })
  })
  return ranked.sort((a, b) => a.tier - b.tier || b.score - a.score || a.index - b.index).map(entry => entry.row)
}
