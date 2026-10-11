import { describe, expect, it } from 'vitest'
import { liveChatTitle, remoteChatTitlesFrom } from './live-chat-title'

describe('liveChatTitle', () => {
  const source = {
    sessions: [{ id: 'alpha', title: 'Alpha plan' }, { id: 'blank', title: '  ' }],
    remoteChatTitles: { 'c18f6435f5ee15b0483471f5/sess_remote': 'Remote plan' }
  }

  it('shows the current title of a chat this server lists', () => {
    expect(liveChatTitle(source, 'alpha', 'New agent')).toBe('Alpha plan')
  })

  it('shows the hub-listed title of a chat on another server by its mailbox id', () => {
    expect(liveChatTitle(source, 'c18f6435f5ee15b0483471f5/sess_remote', 'New agent')).toBe('Remote plan')
  })

  it('keeps the recorded title for an unknown chat, a blank current title, or no id', () => {
    expect(liveChatTitle(source, 'gone', 'Recorded')).toBe('Recorded')
    expect(liveChatTitle(source, 'blank', 'Recorded')).toBe('Recorded')
    expect(liveChatTitle(source, 'c18f6435f5ee15b0483471f5/sess_other', ' Recorded ')).toBe('Recorded')
    expect(liveChatTitle(source, null, 'Recorded')).toBe('Recorded')
    expect(liveChatTitle(source, 'gone', null)).toBe('')
  })

  it('keys the hub chat list by server identity and session id', () => {
    expect(remoteChatTitlesFrom([
      { server_identity: 'c18f6435f5ee15b0483471f5', name: 'studio', chats: [{ id: 'sess_a', title: 'A', folder: null, backend: 'codex', cross_chat_handoff_supported: true }] },
      { server_identity: 'd28f6435f5ee15b0483471f5', name: '', chats: [{ id: 'sess_a', title: 'Hub A', folder: null, backend: 'claude', cross_chat_handoff_supported: true }] }
    ])).toEqual({ 'c18f6435f5ee15b0483471f5/sess_a': 'A', 'd28f6435f5ee15b0483471f5/sess_a': 'Hub A' })
  })
})
