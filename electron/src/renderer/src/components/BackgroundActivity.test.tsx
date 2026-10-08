import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { BackgroundActivityItem, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { BackgroundActivityButton } from './BackgroundActivity'

const session = { id: 'chat-a', title: 'Research', backend: 'codex' } as Session
const shell: BackgroundActivityItem = { id: 'b1', command: 'sleep 600' }
let list: ReturnType<typeof vi.fn>
let stop: ReturnType<typeof vi.fn>

beforeEach(() => {
  list = vi.fn().mockResolvedValue([shell])
  stop = vi.fn().mockResolvedValue(true)
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { backgroundActivity: { list, stop } } as unknown as AgentsDockAPI })
  useAppStore.setState({ activeProfileId: 'server-a', profileGeneration: 3, profiles: [], activeSessionIds: new Set(),
    health: { ok: true, capabilities: { background_activity_v1: { available: true } } } })
})
afterEach(() => cleanup())

describe('BackgroundActivityButton', () => {
  it('shows running background terminals, stops one after confirmation, and reloads when a turn starts', async () => {
    render(<BackgroundActivityButton session={session} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Background terminals: 1 running' }))
    expect(screen.getByText('sleep 600')).toBeVisible()
    expect(list).toHaveBeenCalledWith({ profileId: 'server-a', profileGeneration: 3, serverIdentity: null }, 'chat-a')

    const stopButton = screen.getByRole('button', { name: 'Stop sleep 600' })
    fireEvent.click(stopButton)
    expect(stop).not.toHaveBeenCalled()
    expect(stopButton).toHaveTextContent('Confirm stop')
    list.mockResolvedValue([])
    fireEvent.click(stopButton)
    await waitFor(() => expect(stop).toHaveBeenCalledWith({ profileId: 'server-a', profileGeneration: 3, serverIdentity: null }, 'chat-a', 'b1'))
    await waitFor(() => expect(screen.queryByText('sleep 600')).not.toBeInTheDocument())

    list.mockResolvedValue([{ id: 'b2', command: 'npm run watch' }])
    act(() => useAppStore.setState({ activeSessionIds: new Set(['chat-a']) }))
    expect(await screen.findByRole('button', { name: 'Background terminals: 1 running' })).toBeVisible()
    expect(list).toHaveBeenCalledTimes(3)
  })

  it("lists a Claude chat's agents and shells without a stop, re-checking while its turn runs", async () => {
    // shouldAdvanceTime: waitFor and findByRole poll on real time; only the 15 s interval is advanced by hand.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      list.mockResolvedValue([])
      useAppStore.setState({ activeSessionIds: new Set(['chat-a']) })
      const { container } = render(<BackgroundActivityButton session={{ ...session, backend: 'claude' }} />)
      await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
      expect(container).toBeEmptyDOMElement()
      // The task started after the turn's first check; the next interval finds it.
      list.mockResolvedValue([{ id: 'a1', command: 'Review the diff' }])
      await act(() => vi.advanceTimersByTimeAsync(15_000))
      fireEvent.click(await screen.findByRole('button', { name: 'Background tasks: 1 running' }))
      expect(screen.getByText('Review the diff')).toBeVisible()
      expect(screen.queryByRole('button', { name: /^Stop / })).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stays hidden, without asking, on a server without it', () => {
    useAppStore.setState({ health: { ok: true, capabilities: {} } })
    expect(render(<BackgroundActivityButton session={session} />).container).toBeEmptyDOMElement()
    expect(list).not.toHaveBeenCalled()
  })
})
