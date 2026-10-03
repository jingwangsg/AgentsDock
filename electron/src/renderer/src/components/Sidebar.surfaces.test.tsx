import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile, Session, Surface } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { buildSections, Sidebar } from './Sidebar'

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
const chat = { id: 'chat-1', title: 'Research chat', folder: 'Research', cwd: '/work/research', backend: 'codex' } as Session
const terminal: Surface = { id: 'term_1', kind: 'terminal', name: 'Build shell', folder: 'Research', cwd: '/work/research/app', url: null, page_title: null, created_at: '', updated_at: '' }
const browser: Surface = { id: 'browser_1', kind: 'browser', name: null, folder: 'Reading', cwd: null, url: 'https://docs.example/guide', page_title: 'Docs guide', created_at: '', updated_at: '' }

describe('buildSections with tabs', () => {
  it('lists tabs under their folder and adds folders only a tab lives in after the chat folders', () => {
    const sections = buildSections([chat], ['Research'], '', new Set(), [terminal, browser])
    expect(sections.map(section => section.title)).toEqual(['Research', 'Reading'])
    expect(sections[0].surfaces).toEqual([terminal])
    expect(sections[1].sessions).toEqual([])
    expect(sections[1].surfaces).toEqual([browser])
  })

  it('leaves tabs out of search results', () => {
    const sections = buildSections([chat], ['Research'], 'research', new Set(), [terminal])
    expect(sections).toHaveLength(1)
    expect(sections[0].surfaces).toEqual([])
  })
})

describe('sidebar tabs', () => {
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
      sessions: [chat],
      selectedSessionId: chat.id,
      folderOrder: ['Research'],
      collapsedFolders: new Set(),
      archivedCollapsed: false,
      activeSessionIds: new Set(),
      runtimeCatalog: null,
      health: null,
      surfaces: [terminal, browser],
      selectedSurfaceId: null
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('titles tabs by rename, else page title, and selects one on click, leaving Team Network', () => {
    const closeTeamspace = vi.fn()
    window.addEventListener('agentsdock:close-teamspace', closeTeamspace, { once: true })
    render(<Sidebar />)

    expect(screen.getByText('Build shell').closest('.session-row')).toHaveTextContent('research / app')
    expect(screen.getByText('Docs guide').closest('.session-row')).toHaveTextContent('docs.example')
    expect(screen.getByText('Research chat').closest('.session-row')).toHaveClass('selected')

    fireEvent.click(screen.getByText('Build shell'))

    expect(useAppStore.getState().selectedSurfaceId).toBe('term_1')
    expect(closeTeamspace).toHaveBeenCalledOnce()
    expect(screen.getByText('Build shell').closest('.session-row')).toHaveClass('selected')
    expect(screen.getByText('Research chat').closest('.session-row')).not.toHaveClass('selected')
  })

  it('creates a terminal or browser tab in the folder from its context menu', async () => {
    const createSurface = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ createSurface })
    const user = userEvent.setup()
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Research').closest('.section-header')!)
    await user.click(await screen.findByRole('menuitem', { name: 'New Terminal' }))
    expect(createSurface).toHaveBeenCalledWith('terminal', 'Research')

    fireEvent.contextMenu(screen.getByText('Reading').closest('.section-header')!)
    await user.click(await screen.findByRole('menuitem', { name: 'New Browser' }))
    expect(createSurface).toHaveBeenCalledWith('browser', 'Reading')
  })

  it('renames or closes a tab from its context menu', async () => {
    const removeSurface = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({ removeSurface })
    const rename = vi.fn()
    window.addEventListener('agentsdock:rename-surface', rename, { once: true })
    const user = userEvent.setup()
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Docs guide').closest('.session-row')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename Tab…' }))
    expect(useAppStore.getState().selectedSurfaceId).toBe('browser_1')
    expect((rename.mock.calls[0][0] as CustomEvent<{ surfaceId: string }>).detail).toEqual({ surfaceId: 'browser_1' })

    fireEvent.contextMenu(screen.getByText('Docs guide').closest('.session-row')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Close tab' }))
    expect(removeSurface).toHaveBeenCalledWith('browser_1')
  })
})
