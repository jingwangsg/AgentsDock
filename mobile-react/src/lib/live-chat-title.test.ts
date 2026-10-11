import assert from 'node:assert/strict'
import { liveChatTitle, remoteChatTitlesFrom } from './live-chat-title'

const source = {
  sessions: [{ id: 'alpha', title: 'Alpha plan' }, { id: 'blank', title: '  ' }],
  remoteChatTitles: { 'c18f6435f5ee15b0483471f5/sess_remote': 'Remote plan' },
}

// A chat this server lists shows its current title.
assert.equal(liveChatTitle(source, 'alpha', 'New agent'), 'Alpha plan')
// A chat on another server resolves by its mailbox id from the hub chat list.
assert.equal(liveChatTitle(source, 'c18f6435f5ee15b0483471f5/sess_remote', 'New agent'), 'Remote plan')
// Unknown chat, blank current title, or no id: the recorded title.
assert.equal(liveChatTitle(source, 'gone', 'Recorded'), 'Recorded')
assert.equal(liveChatTitle(source, 'blank', 'Recorded'), 'Recorded')
assert.equal(liveChatTitle(source, 'c18f6435f5ee15b0483471f5/sess_other', ' Recorded '), 'Recorded')
assert.equal(liveChatTitle(source, null, 'Recorded'), 'Recorded')
assert.equal(liveChatTitle(source, 'gone', null), '')

assert.deepEqual(remoteChatTitlesFrom([
  { server_identity: 'c18f6435f5ee15b0483471f5', name: 'studio', chats: [{ id: 'sess_a', title: 'A', folder: null, backend: 'codex', cross_chat_handoff_supported: true }] },
  { server_identity: 'd28f6435f5ee15b0483471f5', name: '', chats: [{ id: 'sess_a', title: 'Hub A', folder: null, backend: 'claude', cross_chat_handoff_supported: true }] },
]), { 'c18f6435f5ee15b0483471f5/sess_a': 'A', 'd28f6435f5ee15b0483471f5/sess_a': 'Hub A' })

console.log('live-chat-title ok')
