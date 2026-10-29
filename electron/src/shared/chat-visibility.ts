import type { Session } from './types'

/**
 * A job run chat is a chat a standalone scheduled job created for one run. The sidebar and search list it
 * only while it is the open chat, archived or not: a job that runs every minute would otherwise fill the
 * list, or the Archived section when the job archives successful runs. The job card in the chat that
 * scheduled the job opens the latest run's chat, and each entry under Previous runs opens its own.
 * ChatGPT.app's Codex sidebar also leaves scheduled runs out of its default view (its Scheduled filter is off).
 */
export function isHiddenRunChat(session: Pick<Session, 'id' | 'scheduled_job_run'>, selectedSessionId: string | null): boolean {
  return Boolean(session.scheduled_job_run) && session.id !== selectedSessionId
}

export function sessionUnread(session: Pick<Session, 'manual_unread' | 'latest_agent_event_seq' | 'last_read_agent_event_seq'>): boolean {
  return Boolean(session.manual_unread) || (session.latest_agent_event_seq ?? 0) > (session.last_read_agent_event_seq ?? 0)
}

/**
 * Unread unarchived chats, without job run chats. It takes no selected chat, so the dock badge and the
 * per-server badges the main process computes from the cache count the same chats. The open run chat,
 * which the sidebar does list, is not counted either; the app marks it read once the window has focus.
 */
export function unreadCount(sessions: readonly Pick<Session, 'archived' | 'scheduled_job_run' | 'manual_unread' | 'latest_agent_event_seq' | 'last_read_agent_event_seq'>[]): number {
  return sessions.filter(session => !session.archived && !session.scheduled_job_run && sessionUnread(session)).length
}
