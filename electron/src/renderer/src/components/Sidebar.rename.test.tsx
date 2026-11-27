import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile, Session } from '@shared/types'
import { RUNNING_FORK_DESCRIPTION, RUNNING_FORK_UNAVAILABLE } from '@shared/session-fork'
import { resetTransientCloseStackForTests } from '../lib/transient-close'
import { useAppStore } from '../store/app-store'
import { RenameChatDialog } from './Dialogs'
import { Sidebar } from './Sidebar'

const profile: PublicServerProfile = {
  id: 'profile-a',
  name: 'Studio',
  serverUrl: 'https://studio.example:7850',
  serverIdentity: 'server-a',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0
}

const session: Session = {
  id: 'chat-1',
  title: 'Original chat',
  folder: 'General',
  backend: 'codex'
}

describe('sidebar chat rename', () => {
  beforeEach(() => {
    resetTransientCloseStackForTests()
    const update = vi.fn().mockImplementation(async (_sessionId: string, patch: Partial<Session>) => ({ ...session, ...patch }))
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        preferences: {
          get: vi.fn().mockResolvedValue(0),
          set: vi.fn().mockResolvedValue(undefined)
        },
      sessions: { update }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      profiles: [profile],
      activeProfileId: profile.id,
      profileGeneration: 1,
      switchingProfileId: null,
      connected: true,
      sessions: [session],
      selectedSessionId: session.id,
      folderOrder: ['General'],
      sharedFolderOrder: false,
      collapsedFolders: new Set(),
      archivedCollapsed: false,
      activeSessionIds: new Set(),
      runtimeCatalog: null,
      health: null,
      error: null
    })
  })

  it.each([false, true])('gates running Fork Chat on completed-prefix support=%s', async supported => {
    useAppStore.setState({
      activeSessionIds: new Set([session.id]),
      health: { ok: true, capabilities: { session_fork_completed_prefix_v1: {
        available: true, version: 1, supported_backends: supported ? ['codex'] : ['claude']
      } } }
    })
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    const fork = await screen.findByRole('menuitem', { name: 'Fork Chat' })

    if (supported) expect(fork).not.toHaveAttribute('data-disabled')
    else expect(fork).toHaveAttribute('data-disabled')
    expect(fork).toHaveAttribute('title', supported ? RUNNING_FORK_DESCRIPTION : RUNNING_FORK_UNAVAILABLE)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renames a chat from its sidebar context menu', async () => {
    const user = userEvent.setup()
    render(<><Sidebar /><RenameChatDialog /></>)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename Chat' }))

    const input = await screen.findByRole('textbox', { name: 'Chat name' })
    expect(input).toHaveValue('Original chat')
    await user.clear(input)
    await user.type(input, '  Deployment notes  ')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(window.agentsDock.sessions.update).toHaveBeenCalledWith('chat-1', { title: 'Deployment notes' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Rename chat' })).not.toBeInTheDocument())
    expect(screen.getByText('Deployment notes')).toBeInTheDocument()
  })

  it('disables blank names and closes unchanged trimmed names without an update', async () => {
    const user = userEvent.setup()
    render(<><Sidebar /><RenameChatDialog /></>)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename Chat' }))
    const input = await screen.findByRole('textbox', { name: 'Chat name' })
    await user.clear(input)
    await user.type(input, '   ')
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    await user.type(input, 'Original chat   ')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    expect(window.agentsDock.sessions.update).not.toHaveBeenCalled()
    expect(screen.queryByRole('heading', { name: 'Rename chat' })).not.toBeInTheDocument()
  })

  it('blocks duplicate updates and closing while a rename is in flight', async () => {
    let resolveUpdate: (value: Session) => void = () => undefined
    vi.mocked(window.agentsDock.sessions.update).mockImplementationOnce(() => (
      new Promise<Session>(resolve => { resolveUpdate = resolve })
    ))
    const user = userEvent.setup()
    render(<><Sidebar /><RenameChatDialog /></>)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename Chat' }))
    const input = await screen.findByRole('textbox', { name: 'Chat name' })
    await user.clear(input)
    await user.type(input, 'Deployment notes')
    const form = input.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)

    expect(window.agentsDock.sessions.update).toHaveBeenCalledTimes(1)
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close Rename chat' })).toBeDisabled()

    await act(async () => {
      resolveUpdate({ ...session, title: 'Deployment notes' })
    })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Rename chat' })).not.toBeInTheDocument())
  })

  it('keeps the rename dialog open when the server rejects the update', async () => {
    vi.mocked(window.agentsDock.sessions.update).mockRejectedValueOnce(new Error('Server unavailable'))
    const user = userEvent.setup()
    render(<><Sidebar /><RenameChatDialog /></>)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename Chat' }))
    const input = await screen.findByRole('textbox', { name: 'Chat name' })
    await user.clear(input)
    await user.type(input, 'Deployment notes')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(useAppStore.getState().error).toBe('Server unavailable'))
    expect(screen.getByRole('heading', { name: 'Rename chat' })).toBeInTheDocument()
    expect(input).toHaveValue('Deployment notes')
    expect(screen.getByText('Original chat')).toBeInTheDocument()
  })

  // Copy Session ID. The chat list carries no provider session ID, and an ID the app holds can predate a rewind
  // that changed it on the server, so the item reads the server's full chat list each time.
  async function copySessionId(serverList: () => Promise<Session[]>, held: Session = session) {
    const listWithProviderIds = vi.fn(serverList)
    const writeClipboard = vi.fn().mockResolvedValue(undefined)
    Object.assign(window.agentsDock, { sessions: { listWithProviderIds }, native: { writeClipboard } })
    useAppStore.setState({ sessions: [held] })
    const user = userEvent.setup()
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Original chat').closest('.session-row')!)
    const labels = (await screen.findAllByRole('menuitem')).map(item => item.textContent)
    expect(labels[labels.indexOf('Rename Chat') + 1]).toBe('Copy Session ID')
    await user.click(screen.getByRole('menuitem', { name: 'Copy Session ID' }))
    return { listWithProviderIds, writeClipboard }
  }

  it('copies the session ID the server lists for the chat, not an older one the app holds', async () => {
    const { listWithProviderIds, writeClipboard } = await copySessionId(
      async () => [{ ...session, codex_thread_id: 'thread-after-rewind' }],
      { ...session, codex_thread_id: 'thread-before-rewind' }
    )

    await waitFor(() => expect(writeClipboard.mock.calls).toEqual([['thread-after-rewind']]))
    expect(listWithProviderIds).toHaveBeenCalledTimes(1)
  })

  it('copies the session ID the server lists for a chat whose row has none', async () => {
    const other: Session = { id: 'chat-2', title: 'Other chat', folder: 'General', backend: 'claude', claude_session_id: 'claude-other' }
    const { writeClipboard } = await copySessionId(async () => [other, { ...session, codex_thread_id: 'thread-listed' }])

    await waitFor(() => expect(writeClipboard.mock.calls).toEqual([['thread-listed']]))
    expect(useAppStore.getState().error).toBeNull()
  })

  it.each([
    ['lists the chat without one', [session]],
    ['no longer lists the chat', []]
  ])('says a chat has no session ID yet when the server %s, and copies nothing', async (_case, listed) => {
    const { writeClipboard } = await copySessionId(async () => listed, { ...session, codex_thread_id: 'thread-held' })

    await waitFor(() => expect(useAppStore.getState().error).toBe('This chat has no session ID yet.'))
    expect(writeClipboard).not.toHaveBeenCalled()
  })

  it('shows why the read of the server\'s list failed, and copies nothing', async () => {
    const { writeClipboard } = await copySessionId(async () => { throw new Error('Server unavailable') }, { ...session, codex_thread_id: 'thread-held' })

    await waitFor(() => expect(useAppStore.getState().error).toBe('Server unavailable'))
    expect(writeClipboard).not.toHaveBeenCalled()
  })

  it('dispatches agentsdock:rename-folder from the folder context menu', async () => {
    useAppStore.setState({ sessions: [{ ...session, folder: 'Research' }], folderOrder: ['Research', 'General'] })
    const renameFolder = vi.fn()
    window.addEventListener('agentsdock:rename-folder', renameFolder, { once: true })
    const user = userEvent.setup()
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Research').closest('.section-header')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Rename Folder…' }))

    expect(renameFolder).toHaveBeenCalledOnce()
    expect((renameFolder.mock.calls[0][0] as CustomEvent<{ folder: string }>).detail).toEqual({ folder: 'Research' })
  })

  it('offers General the same folder actions as any other folder, hiding move items when it is alone', async () => {
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('General').closest('.section-header')!)

    const labels = (await screen.findAllByRole('menuitem')).map(item => item.textContent)
    expect(labels).toEqual(['New Claude Chat', 'New Codex Chat', 'New Terminal', 'New Browser', 'New Subfolder…', 'Rename Folder…', 'Delete Folder'])
  })

  it('lists one New chat entry per ready backend and seeds it with the folder', async () => {
    const requestNewChat = vi.fn().mockResolvedValue(undefined)
    useAppStore.setState({
      requestNewChat,
      sessions: [{ ...session, folder: 'Research' }],
      folderOrder: ['Research'],
      health: { ok: true, capabilities: { cursor_backend: { available: true, required: false, message: '', action: null, version: 2 } } },
      runtimeCatalog: { backends: { cursor: { available: true, models: [{ value: 'auto', label: 'Auto' }], efforts: [] } } }
    })
    const user = userEvent.setup()
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Research').closest('.section-header')!)
    const labels = (await screen.findAllByRole('menuitem')).map(item => item.textContent)
    expect(labels).toEqual(['New Claude Chat', 'New Codex Chat', 'New Cursor Chat', 'New Terminal', 'New Browser', 'New Subfolder…', 'Rename Folder…', 'Delete Folder'])
    await user.click(screen.getByRole('menuitem', { name: 'New Cursor Chat' }))

    expect(requestNewChat).toHaveBeenCalledWith({ folder: 'Research', backend: 'cursor' })
  })

  it('explains an unavailable Gemini CLI from the folder menu without creating a chat', async () => {
    const message = 'The NVIDIA Inference Hub budget for this credential is exhausted.'
    const requestNewChat = vi.fn()
    useAppStore.setState({
      requestNewChat, error: null, sessions: [session], folderOrder: ['General'],
      health: { ok: true, capabilities: { gemini_backend: { available: true, version: 1 } },
        runtimes: { gemini: { backend: 'gemini', status: 'error', available: false, message } } }
    })
    render(<Sidebar />)
    fireEvent.contextMenu(screen.getByText('General').closest('.section-header')!)
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'New Gemini CLI Chat · Unavailable' }))
    expect(useAppStore.getState().error).toBe(message)
    expect(requestNewChat).not.toHaveBeenCalled()
  })

  it('hides Cursor and OpenCode while their CLI is missing on this server', async () => {
    const missing = (backend: 'cursor' | 'opencode') => ({ backend, status: 'missing' as const, available: false, installed: false, authenticated: false, message: `${backend} is not installed.` })
    useAppStore.setState({
      sessions: [{ ...session, folder: 'Research' }],
      folderOrder: ['Research'],
      health: { ok: true, capabilities: {
        cursor_backend: { available: true, required: false, message: '', action: null, version: 2 },
        opencode_backend: { available: true, required: false, message: '', action: null, version: 1 }
      } },
      runtimeCatalog: { backends: {
        cursor: { available: false, models: [], efforts: [], diagnostic: missing('cursor') },
        opencode: { available: false, models: [], efforts: [], diagnostic: missing('opencode') }
      } }
    })
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Research').closest('.section-header')!)
    const labels = (await screen.findAllByRole('menuitem')).map(item => item.textContent)
    expect(labels).toEqual(['New Claude Chat', 'New Codex Chat', 'New Terminal', 'New Browser', 'New Subfolder…', 'Rename Folder…', 'Delete Folder'])
  })

  const nested: Session[] = [
    { ...session, id: 'work', title: 'Work chat', folder: 'Work' },
    { ...session, id: 'papers', title: 'Papers chat', folder: 'Work/Papers' },
    { ...session, id: 'old', title: 'Old chat', folder: 'Work/Papers/2026' },
    { ...session, id: 'lab', title: 'Lab chat', folder: 'Lab' }
  ]
  const headers = () => [...document.querySelectorAll('.section-header')].map(header => ({
    name: header.querySelector('button > span:not(.status-dot)')!.textContent,
    count: header.querySelector('small')!.textContent,
    indent: (header.closest('.sidebar-section') as HTMLElement).style.paddingLeft
  }))

  it('lists a subfolder after its parent by its own name, indented by its depth', () => {
    // The order has the subfolders after Lab: they still follow their parents.
    useAppStore.setState({ sessions: nested, folderOrder: ['Work', 'Lab', 'Work/Papers/2026', 'Work/Papers'] })
    render(<Sidebar />)

    expect(headers()).toEqual([
      { name: 'Work', count: '1', indent: '0px' },
      { name: 'Papers', count: '1', indent: '12px' },
      { name: '2026', count: '1', indent: '24px' },
      { name: 'Lab', count: '1', indent: '0px' }
    ])
  })

  it('hides the subfolders of a collapsed folder and counts their chats in its header', () => {
    useAppStore.setState({ sessions: nested, folderOrder: ['Work', 'Work/Papers', 'Work/Papers/2026', 'Lab'], collapsedFolders: new Set(['Work/Papers']) })
    render(<Sidebar />)

    expect(headers()).toEqual([
      { name: 'Work', count: '1', indent: '0px' },
      { name: 'Papers', count: '2', indent: '12px' },
      { name: 'Lab', count: '1', indent: '0px' }
    ])
    expect(screen.queryByText('Papers chat')).not.toBeInTheDocument()
    expect(screen.queryByText('Old chat')).not.toBeInTheDocument()
    expect(screen.getByText('Work chat')).toBeInTheDocument()
  })

  it('reorders a folder among the folders of its parent, with its subfolders', async () => {
    useAppStore.setState({ sessions: nested, folderOrder: ['Work', 'Work/Papers', 'Work/Papers/2026', 'Lab'] })
    const user = userEvent.setup()
    render(<Sidebar />)

    // Papers is the only folder directly in Work: no Move Folder Up or Down.
    fireEvent.contextMenu(screen.getByText('Papers').closest('.section-header')!)
    expect(await screen.findByRole('menuitem', { name: 'Rename Folder…' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Move Folder Up' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Move Folder Down' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    fireEvent.contextMenu(screen.getByText('Work').closest('.section-header')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Move Folder Down' }))
    expect(useAppStore.getState().folderOrder).toEqual(['Lab', 'Work', 'Work/Papers', 'Work/Papers/2026'])
  })

  it('offers to move a folder to the top level and into every folder except its parent, itself and its subfolders', async () => {
    const renameFolder = vi.fn().mockResolvedValue(true)
    useAppStore.setState({ renameFolder, sessions: nested, folderOrder: ['Work', 'Work/Papers', 'Work/Papers/2026', 'Lab'] })
    const user = userEvent.setup()
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Papers').closest('.section-header')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Move Folder To' }))
    const submenu = within((await screen.findByRole('menuitem', { name: 'Top Level' })).closest('[role="menu"]') as HTMLElement)
    // Not Work, its parent, and not its own subfolder.
    expect(submenu.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Top Level', 'Lab'])
    fireEvent.click(submenu.getByRole('menuitem', { name: 'Lab' }))

    expect(renameFolder).toHaveBeenCalledExactlyOnceWith('Work/Papers', 'Lab/Papers')
  })

  it('asks for a new subfolder from the folder context menu', async () => {
    useAppStore.setState({ sessions: nested, folderOrder: ['Work', 'Lab'] })
    const newFolder = vi.fn()
    window.addEventListener('agentsdock:new-subfolder', newFolder, { once: true })
    const user = userEvent.setup()
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Papers').closest('.section-header')!)
    await user.click(await screen.findByRole('menuitem', { name: 'New Subfolder…' }))

    expect((newFolder.mock.calls[0][0] as CustomEvent<{ parent: string }>).detail).toEqual({ parent: 'Work/Papers' })
  })

  it('moves folders up and down from the context menu and hides the item at the edges', async () => {
    useAppStore.setState({ sessions: [{ ...session, folder: 'Zeta' }], folderOrder: ['Alpha', 'Beta'] })
    const user = userEvent.setup()
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Alpha').closest('.section-header')!)
    expect(await screen.findByRole('menuitem', { name: 'Move Folder Down' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Move Folder Up' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Move Folder Down' }))
    // Zeta is not in folderOrder yet; the swap persists the rendered list so it keeps its place.
    expect(useAppStore.getState().folderOrder).toEqual(['Beta', 'Alpha', 'Zeta'])

    fireEvent.contextMenu(screen.getByText('Zeta').closest('.section-header')!)
    expect(await screen.findByRole('menuitem', { name: 'Move Folder Up' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Move Folder Down' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('menuitem', { name: 'Move Folder Up' }))
    expect(useAppStore.getState().folderOrder).toEqual(['Beta', 'Zeta', 'Alpha'])
  })

  it('sends a moved folder to the shared folder order as the sidebar\'s folder list', async () => {
    const setOrder = vi.fn().mockResolvedValue(undefined)
    const preferences = { get: vi.fn().mockResolvedValue(0), set: vi.fn().mockResolvedValue(undefined), setScoped: vi.fn().mockResolvedValue(undefined) }
    Object.defineProperty(window, 'agentsDock', { configurable: true, value: { preferences, folders: { setOrder } } as unknown as AgentsDockAPI })
    useAppStore.setState({ sessions: [{ ...session, folder: 'Zeta' }], folderOrder: ['Alpha', 'Beta'], sharedFolderOrder: true })
    const user = userEvent.setup()
    render(<Sidebar />)

    fireEvent.contextMenu(screen.getByText('Alpha').closest('.section-header')!)
    await user.click(await screen.findByRole('menuitem', { name: 'Move Folder Down' }))

    expect(setOrder).toHaveBeenCalledExactlyOnceWith({ profileId: profile.id, profileGeneration: 1, serverIdentity: 'server-a' }, ['Beta', 'Alpha', 'Zeta'])
    expect(preferences.setScoped.mock.calls.some(([, key]) => key === 'folderOrder')).toBe(false)
  })

  it('turns the entire chat row amber when an active agent needs user action', () => {
    useAppStore.setState({
      sessions: [{ ...session, backend: 'claude', claude_needs_user_action: true, manual_unread: true }],
      activeSessionIds: new Set([session.id])
    })

    render(<Sidebar />)

    const row = screen.getByText('Original chat').closest('.session-row')
    expect(row).toHaveClass('action-needed')
    expect(row).toHaveClass('unread')
    expect(row).toHaveClass('selected')
    expect(row).toHaveAttribute('title', 'Original chat · action needed')
    expect(row).toHaveTextContent('Claude · action needed')
    expect(row).not.toHaveTextContent('running')
    expect(row?.querySelector('.status-dot')).toHaveClass('attention')
  })

  it('gives a critical emergency red priority over action-needed, running, and unread states', () => {
    useAppStore.setState({
      sessions: [{
        ...session,
        backend: 'claude',
        claude_needs_user_action: true,
        manual_unread: true,
        emergency_alert: {
          id: 'alert-1',
          status: 'active',
          severity: 'critical',
          message: 'The production deploy is failing.',
          raised_at: '2026-08-25T12:00:00Z'
        }
      }],
      activeSessionIds: new Set([session.id])
    })

    render(<Sidebar />)

    const row = screen.getByText('Original chat').closest('.session-row')
    expect(row).toHaveClass('emergency', 'action-needed', 'unread', 'selected')
    expect(row).toHaveAttribute('title', 'Original chat · emergency · The production deploy is failing.')
    expect(row).toHaveAttribute('aria-label', 'Original chat, emergency: The production deploy is failing.')
    expect(row).toHaveTextContent('EMERGENCY · The production deploy is failing.')
    expect(row).not.toHaveTextContent('action needed')
    expect(row).not.toHaveTextContent('running')
    expect(screen.getByRole('alert')).toHaveTextContent('Emergency in Original chat: The production deploy is failing.')
    expect(row?.querySelector('.status-dot')).toHaveClass('emergency')
    expect(row?.querySelector('.status-dot')).not.toHaveClass('attention', 'unread')
  })
})
