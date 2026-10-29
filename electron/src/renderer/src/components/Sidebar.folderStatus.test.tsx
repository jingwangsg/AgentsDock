import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile, Session } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { folderStatusKinds, Sidebar } from './Sidebar'

const profile: PublicServerProfile = {
  id: 'profile-a',
  name: 'Alpha',
  serverUrl: 'https://alpha.example:7850',
  serverIdentity: 'server-a',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0
}
const quiet = { id: 'chat-quiet', title: 'Quiet chat', folder: 'Survey', backend: 'codex', latest_agent_event_seq: 3, last_read_agent_event_seq: 3 } as Session
const unread = { id: 'chat-unread', title: 'Unread chat', folder: 'Survey', backend: 'codex', latest_agent_event_seq: 5, last_read_agent_event_seq: 3 } as Session
const running = { id: 'chat-running', title: 'Running chat', folder: 'Survey', backend: 'claude', latest_agent_event_seq: 2, last_read_agent_event_seq: 2 } as Session
const waiting = { id: 'chat-waiting', title: 'Waiting chat', folder: 'Other', backend: 'claude', claude_needs_user_action: true, latest_agent_event_seq: 1, last_read_agent_event_seq: 1 } as Session
const alarmed = { id: 'chat-alarmed', title: 'Alarmed chat', folder: 'Other', backend: 'claude', archived: true, latest_agent_event_seq: 1, last_read_agent_event_seq: 1,
  emergency_alert: { id: 'alert-1', status: 'active', severity: 'critical', message: 'Disk full', raised_at: '2026-10-10T00:00:00Z' } } as unknown as Session

describe('folderStatusKinds', () => {
  it('lists each kind once, highest priority first, from the folder\'s chats', () => {
    expect(folderStatusKinds([quiet], new Set())).toEqual([])
    expect(folderStatusKinds([unread, running, quiet], new Set([running.id]))).toEqual(['running', 'unread'])
    expect(folderStatusKinds([waiting, unread, unread, alarmed], new Set())).toEqual(['emergency', 'attention', 'unread'])
  })
})

describe('folder header status dots', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: { get: vi.fn().mockResolvedValue(0), set: vi.fn().mockResolvedValue(undefined), getScoped: vi.fn().mockResolvedValue(null), setScoped: vi.fn().mockResolvedValue(undefined) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      profileGeneration: 1,
      switchingProfileId: null,
      connected: true,
      sessions: [quiet, unread, running, waiting, alarmed],
      selectedSessionId: quiet.id,
      folderOrder: ['Survey', 'Other'],
      collapsedFolders: new Set(['Survey']),
      archivedCollapsed: true,
      activeSessionIds: new Set([running.id]),
      runtimeCatalog: null,
      health: null,
      surfaces: [],
      selectedSurfaceId: null
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('shows a collapsed folder\'s running and unread dots before its count, an attention dot where a chat waits, and Archived\'s emergency', () => {
    render(<Sidebar />)

    expect(screen.queryByText('Running chat')).toBeNull()
    const survey = screen.getByText('Survey').closest('button')!
    expect([...survey.querySelectorAll('.status-dot')].map(dot => dot.className)).toEqual(['status-dot running', 'status-dot unread'])
    expect(survey.querySelector('small')).toHaveTextContent('3')
    const other = screen.getByText('Other').closest('button')!
    expect([...other.querySelectorAll('.status-dot')].map(dot => dot.className)).toEqual(['status-dot attention'])
    const archived = screen.getByText('Archived').closest('button')!
    expect([...archived.querySelectorAll('.status-dot')].map(dot => dot.className)).toEqual(['status-dot emergency'])
  })

  it('leaves an unread job run chat out of the list, the chat count and the folder dots unless it is the open chat', () => {
    const runChat = { id: 'chat-run', title: 'Nightly sweep', folder: 'Survey', backend: 'codex', manual_unread: true, scheduled_job_run: { job_id: 'job-1', session_id: quiet.id } } as Session
    useAppStore.setState({ sessions: [quiet, runChat], collapsedFolders: new Set() })
    render(<Sidebar />)

    expect(screen.queryByText('Nightly sweep')).toBeNull()
    expect(screen.getByText('1 chat')).toBeInTheDocument()
    const survey = screen.getByText('Survey').closest('button')!
    expect(survey.querySelectorAll('.status-dot')).toHaveLength(0)
    expect(survey.querySelector('small')).toHaveTextContent('1')

    act(() => useAppStore.setState({ selectedSessionId: runChat.id }))
    expect(screen.getByText('Nightly sweep').querySelector('.session-run-mark')).not.toBeNull()
    expect(screen.getByText('2 chats')).toBeInTheDocument()
    // A terminal tab in front of the open run chat keeps its row.
    act(() => useAppStore.setState({ selectedSurfaceId: 'terminal-1' }))
    expect(screen.getByText('Nightly sweep')).toBeInTheDocument()
  })
})
