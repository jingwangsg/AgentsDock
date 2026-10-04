import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { WaitingForYouBanner } from './WaitingForYouBanner'

afterEach(cleanup)

const session = (overrides: Partial<Session>): Session => ({
  id: 'chat', title: 'Chat', backend: 'claude', cwd: '/tmp',
  created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z',
  ...overrides,
} as Session)

describe('WaitingForYouBanner', () => {
  it('names the other chat whose agent is waiting and opens it', () => {
    const selectSession = vi.fn<(sessionId: string, force?: boolean) => Promise<void>>().mockResolvedValue(undefined)
    useAppStore.setState({
      selectSession,
      selectedSessionId: 'current',
      sessions: [
        // The open chat shows its own shelf, so it is not announced again.
        session({ id: 'current', title: 'Current', claude_needs_user_action: true }),
        session({ id: 'other', title: 'Other', backend: 'codex', codex_pending_interaction_count: 2 }),
        session({ id: 'idle', title: 'Idle' }),
        session({ id: 'gone', title: 'Gone', archived: true, claude_needs_user_action: true }),
      ],
    })
    render(<WaitingForYouBanner />)
    fireEvent.click(screen.getByRole('button', { name: 'Codex is waiting for you in “Other”' }))
    expect(selectSession).toHaveBeenCalledWith('other')
  })

  it('lists several waiting chats, and hiding lasts until a different set is waiting', () => {
    useAppStore.setState({
      selectedSessionId: null,
      sessions: [
        session({ id: 'a', title: 'A', claude_needs_user_action: true }),
        session({ id: 'b', title: 'B', backend: 'codex', codex_needs_user_action: true }),
      ],
    })
    const { rerender } = render(<WaitingForYouBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('2 chats are waiting for you: A, B')
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByRole('status')).toBeNull()
    useAppStore.setState({ sessions: [...useAppStore.getState().sessions, session({ id: 'c', title: 'C', claude_pending_interaction_count: 1 })] })
    rerender(<WaitingForYouBanner />)
    expect(screen.getByRole('status')).toHaveTextContent('3 chats are waiting for you: A, B, C')
  })

  it('renders nothing while no other chat is waiting', () => {
    useAppStore.setState({ selectedSessionId: 'a', sessions: [session({ id: 'a', claude_needs_user_action: true }), session({ id: 'b' })] })
    render(<WaitingForYouBanner />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
