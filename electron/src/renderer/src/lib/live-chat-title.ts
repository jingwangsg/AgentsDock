import type { CrossServerChats, Session } from '@shared/types'

/** What this client knows about chat titles; the store carries both fields. */
export interface LiveChatTitleSource {
  sessions: readonly Pick<Session, 'id' | 'title'>[]
  /** Titles of chats on other servers under the hub, keyed `<server identity>/<session id>`. */
  remoteChatTitles: Readonly<Record<string, string>>
}

/**
 * The chat's current title, or the recorded one when this client does not list the chat or
 * lists it with a blank title.
 * `chatId` is how the server's events name a chat: its session id on this server, or
 * `<server identity>/<session id>` for a chat on another server (the mailbox sender key).
 * Every display of a chat's name resolves through here, so a rename reaches all of them.
 */
export function liveChatTitle(source: LiveChatTitleSource, chatId: string | null | undefined, recorded?: string | null): string {
  const id = chatId?.trim() ?? ''
  const current = !id ? undefined
    : id.includes('/') ? source.remoteChatTitles[id]
      : source.sessions.find(session => session.id === id)?.title
  return current?.trim() || recorded?.trim() || ''
}

/** Keys each hub-listed chat by its mailbox sender key, so an event's chat id indexes `remoteChatTitles` directly. */
export function remoteChatTitlesFrom(servers: readonly CrossServerChats[]): Record<string, string> {
  return Object.fromEntries(servers.flatMap(server => server.chats.map(chat => [`${server.server_identity}/${chat.id}`, chat.title])))
}
