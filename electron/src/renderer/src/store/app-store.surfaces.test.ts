import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile, Session, Surface } from '@shared/types'
import { handleMenuCommand, useAppStore } from './app-store'

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
const surface = (patch: Partial<Surface>): Surface => ({
  id: 'term_1', kind: 'terminal', name: null, folder: 'Research', cwd: '/work/research', url: null, page_title: null,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...patch
})
const stored: Surface[] = [
  surface({ id: 'term_1' }),
  surface({ id: 'browser_1', kind: 'browser', folder: 'General', cwd: null, url: 'https://docs.example', page_title: 'Docs' })
]

let api: { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }

beforeEach(() => {
  api = {
    list: vi.fn().mockResolvedValue(stored),
    create: vi.fn(async (input: { kind: Surface['kind']; folder: string; cwd?: string | null; url?: string | null }) => surface({ id: `${input.kind === 'terminal' ? 'term' : 'browser'}_new`, kind: input.kind, folder: input.folder, cwd: input.cwd ?? null, url: input.url ?? null })),
    update: vi.fn(async (id: string, patch: Partial<Surface>) => ({ ...stored.find(item => item.id === id)!, ...patch, updated_at: '2026-10-02T00:00:00Z' })),
    remove: vi.fn().mockResolvedValue(undefined)
  }
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { surfaces: api } as unknown as AgentsDockAPI })
  useAppStore.setState({
    profiles: [profile],
    activeProfileId: profile.id,
    profileGeneration: 2,
    switchingProfileId: null,
    sessions: [
      { id: 'chat-old', title: 'Old', folder: 'Research', cwd: '/work/older', created_at: '2026-09-01T00:00:00Z', backend: 'codex' } as Session,
      { id: 'chat-new', title: 'New', folder: 'Research', cwd: '/work/newer', created_at: '2026-09-02T00:00:00Z', backend: 'claude' } as Session
    ],
    health: { ok: true, default_cwd: '/home/default' },
    surfaces: [],
    surfacesRevision: undefined,
    selectedSurfaceId: null,
    error: null
  })
})

afterEach(() => vi.restoreAllMocks())

describe('terminal and browser tabs', () => {
  it('reads the server\'s tabs and forgets a selection that no longer exists', async () => {
    useAppStore.setState({ selectedSurfaceId: 'term_gone' })
    await useAppStore.getState().refreshSurfaces()
    expect(useAppStore.getState().surfaces).toEqual(stored)
    expect(useAppStore.getState().selectedSurfaceId).toBeNull()
  })

  it('reads the tabs at launch from the bootstrap health, before any connection report arrives', async () => {
    const launch = (health: Record<string, unknown>) => {
      Object.defineProperty(window, 'agentsDock', {
        configurable: true,
        value: {
          bootstrap: vi.fn().mockResolvedValue({
            settings: { serverUrl: profile.serverUrl, hasAccessToken: true, serverSetupComplete: true },
            health, sessions: [], jobs: [], runtimeCatalog: null,
            folderOrder: [], collapsedFolders: [], archivedCollapsed: false
          }),
          surfaces: api,
          native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
          preferences: { get: vi.fn().mockResolvedValue(undefined) },
          events: { on: vi.fn(() => () => {}) }
        } as unknown as AgentsDockAPI
      })
      useAppStore.setState({ initialized: false, activeProfileId: null, profileGeneration: 0, selectedSessionId: null, sessions: [] })
      return useAppStore.getState().initialize()
    }

    // An older server reports no tab revision and has no tab endpoint to read.
    await launch({ ok: true })
    expect(api.list).not.toHaveBeenCalled()
    expect(useAppStore.getState().surfacesRevision).toBeUndefined()

    await launch({ ok: true, surfaces_revision: 7 })
    await vi.waitFor(() => expect(useAppStore.getState().surfaces).toEqual(stored))
    expect(api.list).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().surfacesRevision).toBe(7)
  })

  it('toggles the sidebar when the main process relays the chord typed into a browser tab\'s page', () => {
    const toggled = vi.fn()
    window.addEventListener('agentsdock:toggle-sidebar', toggled)
    handleMenuCommand('toggle-sidebar', useAppStore.getState, useAppStore.setState)
    window.removeEventListener('agentsdock:toggle-sidebar', toggled)
    expect(toggled).toHaveBeenCalledOnce()
  })

  it('drops a list that arrives after the profile changed', async () => {
    const pending = useAppStore.getState().refreshSurfaces()
    useAppStore.setState({ profileGeneration: 3 })
    await pending
    expect(useAppStore.getState().surfaces).toEqual([])
  })

  it('creates a terminal tab in the folder, seeded with the folder\'s newest chat directory, and selects it', async () => {
    await useAppStore.getState().createSurface('terminal', 'Research')
    expect(api.create).toHaveBeenCalledWith({ kind: 'terminal', folder: 'Research', cwd: '/work/newer' })
    const state = useAppStore.getState()
    expect(state.surfaces.map(item => item.id)).toEqual(['term_new'])
    expect(state.selectedSurfaceId).toBe('term_new')
  })

  it('creates a browser tab without a directory and falls back to the server default directory for terminals', async () => {
    await useAppStore.getState().createSurface('browser', 'Ideas')
    await useAppStore.getState().createSurface('terminal', 'Ideas')
    expect(api.create).toHaveBeenNthCalledWith(1, { kind: 'browser', folder: 'Ideas', cwd: null })
    expect(api.create).toHaveBeenNthCalledWith(2, { kind: 'terminal', folder: 'Ideas', cwd: '/home/default' })
  })

  it('opens a web link in the browser tab already showing it, else in a new tab in the chat\'s folder', async () => {
    const closeTeamspace = vi.fn()
    window.addEventListener('agentsdock:close-teamspace', closeTeamspace)
    useAppStore.setState({ surfaces: stored, selectedSurfaceId: null })
    // Addresses compare parsed: the tab recorded the navigated page with its trailing slash.
    await useAppStore.getState().openLinkInBrowser('https://docs.example/', 'chat-new')
    expect(api.create).not.toHaveBeenCalled()
    expect(useAppStore.getState().selectedSurfaceId).toBe('browser_1')
    // A path recorded with its redirect slash still matches the link without it; the fragment does not count.
    useAppStore.setState({ surfaces: [...stored, surface({ id: 'browser_guide', kind: 'browser', cwd: null, url: 'https://docs.example/guide/' })], selectedSurfaceId: null })
    await useAppStore.getState().openLinkInBrowser('https://docs.example/guide#top', 'chat-new')
    expect(api.create).not.toHaveBeenCalled()
    expect(useAppStore.getState().selectedSurfaceId).toBe('browser_guide')
    await useAppStore.getState().openLinkInBrowser('https://example.com/page', 'chat-new')
    expect(api.create).toHaveBeenLastCalledWith({ kind: 'browser', folder: 'Research', cwd: null, url: 'https://example.com/page' })
    expect(useAppStore.getState().selectedSurfaceId).toBe('browser_new')
    await useAppStore.getState().openLinkInBrowser('https://example.com/other', null)
    expect(api.create).toHaveBeenLastCalledWith({ kind: 'browser', folder: 'General', cwd: null, url: 'https://example.com/other' })
    // Two reuses and two creations each brought the tab area forward.
    expect(closeTeamspace).toHaveBeenCalledTimes(4)
    window.removeEventListener('agentsdock:close-teamspace', closeTeamspace)
  })

  it('falls back to the system browser when the server refuses the tab', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { surfaces: api, native: { openExternal } } as unknown as AgentsDockAPI })
    const closeTeamspace = vi.fn()
    window.addEventListener('agentsdock:close-teamspace', closeTeamspace)
    api.create.mockRejectedValueOnce(new Error('refused'))
    await useAppStore.getState().openLinkInBrowser('https://example.com/refused', null)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/refused')
    expect(useAppStore.getState().error).toBe('refused')
    // The teamspace is only closed once there is a tab to show.
    expect(closeTeamspace).not.toHaveBeenCalled()
    window.removeEventListener('agentsdock:close-teamspace', closeTeamspace)
  })

  it('renames and records a browser tab\'s page through the server, keeping the server\'s copy', async () => {
    await useAppStore.getState().refreshSurfaces()
    await useAppStore.getState().updateSurface('browser_1', { name: 'GitHub' })
    await useAppStore.getState().updateSurface('browser_1', { url: 'https://github.com', page_title: 'GitHub · Home' })
    expect(api.update).toHaveBeenNthCalledWith(1, 'browser_1', { name: 'GitHub' })
    expect(api.update).toHaveBeenNthCalledWith(2, 'browser_1', { url: 'https://github.com', page_title: 'GitHub · Home' })
    expect(useAppStore.getState().surfaces[1]).toMatchObject({ url: 'https://github.com', page_title: 'GitHub · Home', updated_at: '2026-10-02T00:00:00Z' })
  })

  it('removes a tab locally first, clears its selection, and reloads the list when the server refuses', async () => {
    await useAppStore.getState().refreshSurfaces()
    useAppStore.getState().selectSurface('browser_1')
    await useAppStore.getState().removeSurface('browser_1')
    expect(api.remove).toHaveBeenCalledWith('browser_1')
    expect(useAppStore.getState().surfaces.map(item => item.id)).toEqual(['term_1'])
    expect(useAppStore.getState().selectedSurfaceId).toBeNull()

    api.remove.mockRejectedValueOnce(new Error('offline'))
    await useAppStore.getState().removeSurface('term_1')
    expect(useAppStore.getState().error).toBe('offline')
    expect(api.list).toHaveBeenCalledTimes(2)
  })

  it('clears the selection when the chosen tab no longer exists', async () => {
    await useAppStore.getState().refreshSurfaces()
    useAppStore.getState().selectSurface('term_1')
    expect(useAppStore.getState().selectedSurfaceId).toBe('term_1')
    useAppStore.getState().selectSurface('nope')
    expect(useAppStore.getState().selectedSurfaceId).toBeNull()
  })

  it('loads the tabs on the first health report even when the bootstrap already carried its revision, then only when the revision moves', async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    const health = { ok: true, surfaces_revision: 7 }
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        surfaces: api,
        bootstrap: vi.fn().mockResolvedValue({ settings: { serverUrl: 'http://example.test', hasAccessToken: false, serverSetupComplete: true }, health, sessions: [], jobs: [], runtimeCatalog: null, folderOrder: [], collapsedFolders: [], archivedCollapsed: false }),
        native: { log: vi.fn().mockResolvedValue(undefined), setBadge: vi.fn().mockResolvedValue(undefined) },
        events: { on: vi.fn((channel: string, handler: (payload: unknown) => void) => { handlers.set(channel, handler); return () => {} }) }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({ initialized: false, activeProfileId: null, profileGeneration: 0 })
    await useAppStore.getState().initialize()
    // The main process hands the renderer its current health, revision included.
    expect(useAppStore.getState().health).toEqual(health)
    const report = (surfaces_revision: number) => handlers.get('server:connection')?.({ profileId: null, profileGeneration: 0, connected: true, health: { ok: true, surfaces_revision } })

    report(7)
    await vi.waitFor(() => expect(useAppStore.getState().surfaces).toEqual(stored))
    report(7)
    await Promise.resolve()
    expect(api.list).toHaveBeenCalledTimes(1)
    report(8)
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
  })

  it('re-reads the tabs with the sidebar refresh only once the server has reported a tab revision', async () => {
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { surfaces: api, sessions: { list: vi.fn().mockResolvedValue([]) } } as unknown as AgentsDockAPI })
    await useAppStore.getState().refreshSessions()
    expect(api.list).not.toHaveBeenCalled()

    useAppStore.setState({ surfacesRevision: 7 })
    await useAppStore.getState().refreshSessions()
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1))
  })
})
