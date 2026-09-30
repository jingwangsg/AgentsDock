import type { Backend, Health } from '../types'

const MAX_QUESTION_CHARS = 8000

/** A tool call or interim message of a Codex side answer (Claude side questions have no tools). */
export interface SideChatStep {
  id: string
  kind: 'command' | 'file_change' | 'tool' | 'web_search' | 'message'
  title: string
  status: 'running' | 'completed' | 'failed'
  output?: string
}

/** Server-owned side chat: the desktop shows the same conversation, and it survives restarts. */
export interface SyncedSideChat {
  session_id: string
  side_chat_id: string
  revision: number
  last_request_id: string | null
  exchanges: Array<{
    request_id: string
    question: string
    status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
    answer?: string
    context_note?: string
    error?: string
    steps?: SideChatStep[]
  }>
}

/** Only the synced side chat is offered; older servers keep their history on the desktop that asked. */
export function sideChatAvailable(health: Health | null, backend: Backend): boolean {
  const capability = health?.capabilities?.side_questions
  return (backend === 'codex' || backend === 'claude')
    && capability?.available === true && capability.version === 2
    && capability.native_context === true && capability.sync === true
    && Array.isArray(capability.backends) && capability.backends.includes(backend)
}

export function sideChatLimit(health: Health | null): number {
  const limit = health?.capabilities?.side_questions?.max_question_chars
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_QUESTION_CHARS) : MAX_QUESTION_CHARS
}

export function parseSyncedSideChat(value: unknown, sessionId: string): SyncedSideChat {
  const chat = value as Partial<SyncedSideChat> | null
  if (!chat || chat.session_id !== sessionId || typeof chat.side_chat_id !== 'string'
    || !Number.isSafeInteger(chat.revision) || !Array.isArray(chat.exchanges)) {
    throw new Error('side_question_invalid_response')
  }
  return chat as SyncedSideChat
}

/** The desktop's wording for request failures (`status`) and failed exchanges (`side_question_*` codes). */
export function sideChatErrorMessage(cause: unknown): string {
  const status = cause && typeof cause === 'object' && 'status' in cause ? (cause as { status: unknown }).status : undefined
  const code = typeof status === 'number' ? `side_question_http_${status}` : cause instanceof Error ? cause.message : String(cause)
  if (/side_question_interrupted/.test(code)) return 'This response was interrupted when the server restarted.'
  if (/side_question_http_(?:404|405|501)/.test(code)) return 'Native Side chat requires an updated AgentsServer and a supported provider.'
  if (/side_question_http_(?:401|403)/.test(code)) return 'This connection is not authorized to ask side questions.'
  if (/side_question_http_409/.test(code)) return 'Native conversation context is not available yet, or another side question is running. Wait for it to finish before asking again.'
  if (/side_question_http_410/.test(code)) return 'This native side conversation has ended. Clear Side chat to start again from the current main conversation.'
  if (/side_question_http_429/.test(code)) return 'The server is already answering the maximum number of side questions. Try again after one finishes.'
  if (/side_question_http_503/.test(code)) return 'The provider could not answer a side question. Check its connection and try again.'
  if (/side_question_http_504|timeout|timed out/i.test(code)) return 'The side question timed out before an answer arrived. Your main task continues.'
  return 'The side question could not be answered. Check the server connection and try again. Your main task continues.'
}

interface SideChatChangedNotification {
  profileId: string
  profileGeneration: number
  sessionId: string
  revision: number
}

type SideChatListener = (notification: SideChatChangedNotification) => void

const listeners = new Set<SideChatListener>()

/** `side_chat_updated` packets only invalidate: an open side chat reads the new revision. */
export function publishSideChatChanged(notification: SideChatChangedNotification): void {
  for (const listener of [...listeners]) listener(notification)
}

export function subscribeSideChatChanged(listener: SideChatListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
