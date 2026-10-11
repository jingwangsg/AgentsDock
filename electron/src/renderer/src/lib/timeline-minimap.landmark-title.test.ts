import { describe, expect, it } from 'vitest'
import { liveLandmarkTitle } from './timeline-minimap'

describe('liveLandmarkTitle', () => {
  const source = { sessions: [{ id: 'peer', title: 'Peer renamed' }], remoteChatTitles: { 'c18f6435f5ee15b0483471f5/sess_r': 'Remote renamed' } }
  const landmark = { key: 'cross-chat:handoff:one', kind: 'system' as const, start_seq: 1, end_seq: 1, title: 'Sent to Peer', preview: '' }

  it('names a message landmark after the other chat\'s current title, in both directions', () => {
    expect(liveLandmarkTitle({ ...landmark, counterpart_session_id: 'peer', direction: 'outgoing' }, source)).toBe('Sent to Peer renamed')
    expect(liveLandmarkTitle({ ...landmark, counterpart_session_id: 'peer', direction: 'incoming' }, source)).toBe('Message from Peer renamed')
    expect(liveLandmarkTitle({ ...landmark, counterpart_session_id: 'c18f6435f5ee15b0483471f5/sess_r', direction: 'outgoing' }, source)).toBe('Sent to Remote renamed')
  })

  it('keeps the built title for an unknown chat or any other landmark', () => {
    expect(liveLandmarkTitle({ ...landmark, counterpart_session_id: 'gone', direction: 'outgoing' }, source)).toBe('Sent to Peer')
    expect(liveLandmarkTitle({ ...landmark, title: 'Agent turn' }, source)).toBe('Agent turn')
  })
})
