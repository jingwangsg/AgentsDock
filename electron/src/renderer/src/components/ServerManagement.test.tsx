import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { trackEvent } from '../lib/analytics'
import { ServerManagement } from './ServerManagement'

vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }))

const alpha: PublicServerProfile = {
  id: 'alpha',
  name: 'Alpha',
  serverUrl: 'https://alpha.example:7850',
  serverIdentity: 'server-alpha',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0
}

const beta: PublicServerProfile = {
  id: 'beta',
  name: 'Beta',
  serverUrl: 'https://beta.example:7850',
  serverIdentity: 'server-beta',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'cached',
  cachedUnreadCount: 2
}

const gamma: PublicServerProfile = {
  ...beta,
  id: 'gamma',
  name: 'Gamma',
  serverUrl: 'https://gamma.example:7850',
  serverIdentity: 'server-gamma'
}

// The local hub and two remotes it registered; remotes are proxied through the hub URL.
const hub: PublicServerProfile = {
  id: 'hub',
  name: 'This Mac',
  serverUrl: 'http://127.0.0.1:7850',
  serverIdentity: 'server-hub',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0
}

const osmo: PublicServerProfile = {
  id: 'osmo',
  name: 'OSMO',
  serverUrl: 'http://127.0.0.1:7850/api/remote/abc123def456',
  sshHost: 'osmo_9000',
  serverIdentity: 'server-osmo',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'cached',
  cachedUnreadCount: 0
}

const gb300: PublicServerProfile = {
  ...osmo,
  id: 'gb300',
  name: 'GB300',
  serverUrl: 'http://127.0.0.1:7850/api/remote/fedcba654321',
  sshHost: 'nv_gb300',
  serverIdentity: 'server-gb300'
}

describe('ServerManagement', () => {
  const list = vi.fn()
  const update = vi.fn()
  const remove = vi.fn()
  const reorder = vi.fn()
  const remoteDeploy = vi.fn()
  const remoteAttach = vi.fn()
  const remoteCancel = vi.fn()
  const remoteRemove = vi.fn()
  const remoteRedeploy = vi.fn()
  const pairingUrl = vi.fn()
  const copyToken = vi.fn()
  const startLocalServer = vi.fn()
  const switchServer = vi.fn()

  beforeEach(() => {
    vi.mocked(trackEvent).mockClear()
    list.mockReset().mockResolvedValue([alpha, beta])
    update.mockReset().mockResolvedValue(alpha)
    remove.mockReset().mockResolvedValue(true)
    reorder.mockReset().mockResolvedValue([beta, alpha])
    remoteDeploy.mockReset().mockResolvedValue(gb300)
    remoteAttach.mockReset().mockResolvedValue(gb300)
    remoteCancel.mockReset().mockResolvedValue(undefined)
    remoteRemove.mockReset().mockResolvedValue(undefined)
    remoteRedeploy.mockReset()
    pairingUrl.mockReset().mockResolvedValue('http://nvmac.tail46daa8.ts.net:7850')
    copyToken.mockReset().mockResolvedValue(true)
    startLocalServer.mockReset().mockResolvedValue(undefined)
    switchServer.mockReset().mockImplementation(async (profileId: string) => {
      useAppStore.setState(state => ({ activeProfileId: profileId, profileGeneration: state.profileGeneration + 1 }))
      return true
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        servers: { list, update, remove, reorder },
        remoteServers: { deploy: remoteDeploy, attach: remoteAttach, cancel: remoteCancel, remove: remoteRemove, redeploy: remoteRedeploy },
        hub: { pairingUrl, copyToken, startLocalServer }
      } as unknown as AgentsDockAPI
    })
    useAppStore.setState({
      profiles: [alpha],
      activeProfileId: alpha.id,
      profileGeneration: 1,
      switchingProfileId: null,
      switchServer
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('deploys a remote through the local hub, refreshes the list and switches to it', async () => {
    list.mockResolvedValue([hub, osmo, gb300])
    useAppStore.setState({ profiles: [hub, osmo], activeProfileId: hub.id })
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('SSH host'), 'nv_gb300')
    await user.click(screen.getByRole('button', { name: 'Add & switch' }))

    await waitFor(() => expect(switchServer).toHaveBeenCalledWith('gb300'))
    expect(remoteDeploy).toHaveBeenCalledWith(
      { profileId: 'hub', profileGeneration: 1, serverIdentity: 'server-hub' },
      { sshHost: 'nv_gb300', installDir: '~/.agentsdock-server', name: undefined }
    )
    expect(useAppStore.getState().profiles.map(profile => profile.id)).toEqual(['hub', 'osmo', 'gb300'])
    expect(trackEvent).toHaveBeenCalledWith('server_added', { success: true })
    expect(screen.queryByRole('button', { name: 'Add & switch' })).not.toBeInTheDocument()
  })

  it('attaches an existing remote through the hub instead of deploying, then switches to it', async () => {
    list.mockResolvedValue([hub, osmo, gb300])
    useAppStore.setState({ profiles: [hub, osmo], activeProfileId: hub.id })
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    expect(screen.getByRole('button', { name: 'Deploy a new server' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'Attach an existing server' }))
    expect(screen.getByRole('button', { name: 'Attach an existing server' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/Nothing is uploaded and the server is not restarted/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('SSH host'), 'nv_gb300')
    await user.clear(screen.getByLabelText('Install directory on the host'))
    await user.type(screen.getByLabelText('Install directory on the host'), '/mnt/lustre/.agentsdock-server')
    await user.click(screen.getByRole('button', { name: 'Add & switch' }))

    await waitFor(() => expect(switchServer).toHaveBeenCalledWith('gb300'))
    expect(remoteAttach).toHaveBeenCalledWith(
      { profileId: 'hub', profileGeneration: 1, serverIdentity: 'server-hub' },
      { sshHost: 'nv_gb300', installDir: '/mnt/lustre/.agentsdock-server', name: undefined }
    )
    expect(remoteDeploy).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeProfileId).toBe('gb300')
    expect(screen.queryByRole('button', { name: 'Add & switch' })).not.toBeInTheDocument()
  })

  it('cancels an in-flight deployment through the hub', async () => {
    let rejectDeploy!: (error: Error) => void
    remoteDeploy.mockImplementation(() => new Promise<PublicServerProfile>((_resolve, reject) => { rejectDeploy = reject }))
    remoteCancel.mockImplementation(async () => rejectDeploy(new Error('Deployment cancelled.')))
    useAppStore.setState({ profiles: [hub], activeProfileId: hub.id })
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('SSH host'), 'nv_gb300')
    await user.click(screen.getByRole('button', { name: 'Add & switch' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(remoteCancel).toHaveBeenCalledOnce())
    expect(await screen.findByRole('alert')).toHaveTextContent('Deployment cancelled.')
    expect(trackEvent).toHaveBeenCalledWith('server_added', { success: false })
    expect(switchServer).not.toHaveBeenCalled()
  })

  it('removes a hub-managed remote through the hub and refreshes the list', async () => {
    list.mockResolvedValue([hub])
    useAppStore.setState({ profiles: [hub, osmo], activeProfileId: hub.id })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Remove OSMO' }))
    expect(remoteRemove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove OSMO' }))

    await waitFor(() => expect(remoteRemove).toHaveBeenCalledWith({ profileId: 'hub', profileGeneration: 1, serverIdentity: 'server-hub' }, 'abc123def456'))
    expect(remove).not.toHaveBeenCalled()
    await waitFor(() => expect(useAppStore.getState().profiles.map(profile => profile.id)).toEqual(['hub']))
  })

  it('redeploys a remote while another server is active, asking first when its chats are running', async () => {
    remoteRedeploy.mockImplementation(async (_profileId: string, force: boolean) => force ? { redeployed: true, running: 0 } : { redeployed: false, running: 2 })
    useAppStore.setState({ profiles: [hub, osmo, gb300], activeProfileId: gb300.id })
    const user = userEvent.setup()
    render(<ServerManagement />)
    expect(screen.queryByRole('button', { name: 'Redeploy This Mac' })).toBeNull()

    // A double click on the icon only checks twice; confirming is a separate button.
    await user.dblClick(screen.getByRole('button', { name: 'Redeploy OSMO' }))
    expect(await screen.findByText('2 running chats will stop.')).toBeInTheDocument()
    expect(remoteRedeploy.mock.calls.every(([, force]) => force === false)).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Redeploy anyway' }))

    await waitFor(() => expect(remoteRedeploy).toHaveBeenLastCalledWith('osmo', true))
    expect(await screen.findByText('Redeployed.')).toBeInTheDocument()
  })

  it('asks before redeploying a remote whose running chats could not be checked', async () => {
    remoteRedeploy.mockResolvedValue({ redeployed: false, running: null })
    useAppStore.setState({ profiles: [hub, osmo], activeProfileId: hub.id })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Redeploy OSMO' }))
    expect(await screen.findByText("Couldn't check this server for running chats.")).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByText("Couldn't check this server for running chats.")).toBeNull()
    expect(remoteRedeploy).toHaveBeenCalledOnce()
  })

  it('shows remotes by SSH host, never offers to delete the hub, and locks changes while a remote is active', () => {
    useAppStore.setState({ profiles: [hub, osmo, gb300], activeProfileId: hub.id })
    render(<ServerManagement />)

    expect(screen.getByText('osmo_9000')).toBeInTheDocument()
    expect(screen.getByText('nv_gb300')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove This Mac|Cannot remove active server This Mac/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Remove OSMO' })).toBeEnabled()

    act(() => useAppStore.setState({ activeProfileId: osmo.id }))

    expect(screen.getByRole('button', { name: 'Add server' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add server' })).toHaveAttribute('title', 'Switch to the local server first.')
    expect(screen.getByRole('button', { name: 'Remove GB300' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove GB300' })).toHaveAttribute('title', 'Switch to the local server first.')
    expect(screen.queryByRole('button', { name: /Remove This Mac|Cannot remove active server This Mac/ })).not.toBeInTheDocument()
  })

  it('shows the phone pairing address and copies the hub token from the main process', async () => {
    useAppStore.setState({ profiles: [hub], activeProfileId: hub.id })
    const user = userEvent.setup()
    render(<ServerManagement />)

    expect(screen.getByText('Pair a phone')).toBeInTheDocument()
    expect(await screen.findByText('http://nvmac.tail46daa8.ts.net:7850')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy token' }))

    await waitFor(() => expect(copyToken).toHaveBeenCalledOnce())
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('offers Start only while the local server is down and shows why a start failed', async () => {
    const down = { ...hub, connectionState: 'offline' as const, lastConnectionError: 'fetch failed' }
    useAppStore.setState({ profiles: [down, osmo], activeProfileId: hub.id })
    startLocalServer.mockRejectedValueOnce(new Error('No AgentsServer LaunchAgent in /Users/me/Library/LaunchAgents'))
    const user = userEvent.setup()
    const { rerender } = render(<ServerManagement />)

    expect(screen.queryByRole('button', { name: 'Start OSMO' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start This Mac' }))
    expect(await screen.findByText('No AgentsServer LaunchAgent in /Users/me/Library/LaunchAgents')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Start This Mac' }))
    await waitFor(() => expect(startLocalServer).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('fetch failed')).toBeInTheDocument()

    act(() => useAppStore.setState({ profiles: [hub, osmo] }))
    rerender(<ServerManagement />)
    expect(screen.queryByRole('button', { name: 'Start This Mac' })).not.toBeInTheDocument()
  })

  it('reveals and focuses the editor when Add server is clicked directly', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView
    })
    useAppStore.setState({ profiles: [hub], activeProfileId: hub.id })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Add server' }))

    expect(screen.getByLabelText('SSH host')).toHaveFocus()
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('protects the active profile and requires confirmation before removing another profile', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    list.mockResolvedValue([alpha])
    const user = userEvent.setup()
    render(<ServerManagement />)

    expect(screen.getByRole('button', { name: 'Cannot remove active server Alpha' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Remove Beta' }))
    expect(remove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove Beta' }))

    await waitFor(() => expect(remove).toHaveBeenCalledWith('beta'))
    expect(remoteRemove).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeProfileId).toBe('alpha')
    expect(useAppStore.getState().profiles.map(profile => profile.id)).toEqual(['alpha'])
  })

  it('gives every server activation action a target-specific accessible name', () => {
    useAppStore.setState({ profiles: [alpha, beta, gamma] })

    render(<ServerManagement />)

    expect(screen.getByRole('button', { name: 'Use Beta' })).toHaveTextContent('Use')
    expect(screen.getByRole('button', { name: 'Use Gamma' })).toHaveTextContent('Use')
    expect(screen.queryByRole('button', { name: 'Use Alpha' })).not.toBeInTheDocument()
  })

  it('shows switching progress and closes Settings after the requested server is active', async () => {
    let finishSwitch!: () => void
    switchServer.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      finishSwitch = () => {
        useAppStore.setState(state => ({ activeProfileId: beta.id, profileGeneration: state.profileGeneration + 1 }))
        resolve(true)
      }
    }))
    useAppStore.setState(state => ({
      profiles: [alpha, beta],
      modals: { ...state.modals, settings: true }
    }))
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Use Beta' }))
    expect(screen.getByRole('button', { name: 'Switching to Beta' })).toHaveTextContent('Switching…')
    expect(useAppStore.getState().modals.settings).toBe(true)

    finishSwitch()
    await waitFor(() => expect(useAppStore.getState().modals.settings).toBe(false))
    expect(useAppStore.getState().activeProfileId).toBe(beta.id)
  })

  it('keeps Settings open and explains a failed server activation inline', async () => {
    switchServer.mockRejectedValueOnce(new Error('Server did not answer'))
    useAppStore.setState(state => ({
      profiles: [alpha, beta],
      modals: { ...state.modals, settings: true }
    }))
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Use Beta' }))

    expect(await screen.findByText('Server did not answer')).toHaveClass('server-management-error')
    expect(useAppStore.getState().modals.settings).toBe(true)
    expect(screen.getByRole('button', { name: 'Use Beta' })).toBeEnabled()
  })

  it('shows reachability independently from the single active selection', () => {
    useAppStore.setState({
      profiles: [alpha, { ...beta, connectionState: 'online' }],
      activeProfileId: alpha.id
    })

    render(<ServerManagement />)

    expect(screen.getAllByRole('img', { name: 'Online' })).toHaveLength(2)
    expect(screen.getAllByText('Active')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Use Beta' })).toBeEnabled()
  })

  it('shows an inactive degraded server and its tmux warning in amber', () => {
    const message = 'tmux is missing; terminal sessions and detached updates are unavailable.'
    useAppStore.setState({
      profiles: [alpha, { ...beta, connectionState: 'degraded', lastConnectionError: message }],
      activeProfileId: alpha.id
    })

    render(<ServerManagement />)

    expect(screen.getByRole('img', { name: `Degraded: ${message}` })).toHaveClass('degraded')
    expect(screen.getByText(message)).toHaveClass('server-management-warning')
    expect(screen.getAllByText('Active')).toHaveLength(1)
  })

  it('shows the last known server version with the canonical identity', () => {
    useAppStore.setState({ profiles: [{ ...alpha, serverVersion: '1.4.2' }] })

    render(<ServerManagement />)

    expect(screen.getByText('Identity: server-alpha · AgentsServer 1.4.2')).toBeInTheDocument()
  })

  it('persists profile order returned by the main process', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Move Beta up' }))

    await waitFor(() => expect(reorder).toHaveBeenCalledWith(['beta', 'alpha']))
    expect(useAppStore.getState().profiles.map(profile => profile.id)).toEqual(['beta', 'alpha'])
  })

  it('does not reconnect the active server for a name-only edit', async () => {
    list.mockResolvedValue([{ ...alpha, name: 'Renamed Alpha' }])
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Edit Alpha' }))
    await user.clear(screen.getByLabelText('Name on this Mac'))
    await user.type(screen.getByLabelText('Name on this Mac'), 'Renamed Alpha')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(update).toHaveBeenCalledWith('alpha', { name: 'Renamed Alpha' }))
    expect(switchServer).not.toHaveBeenCalled()
  })

  it('keeps an active identity reset pending until the guarded store switch completes', async () => {
    const changed = { ...alpha, lastConnectionError: 'Server identity changed from server-alpha to server-new.' }
    useAppStore.setState({ profiles: [changed] })
    list.mockResolvedValue([{ ...changed, serverIdentity: null, lastConnectionError: null }])
    let releaseSwitch!: () => void
    switchServer.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      releaseSwitch = () => {
        useAppStore.setState(state => ({ profileGeneration: state.profileGeneration + 1 }))
        resolve(true)
      }
    }))
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Edit Alpha' }))
    await user.click(screen.getByLabelText(/I confirm this URL may establish a new server identity/))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(switchServer).toHaveBeenCalledWith('alpha', true, { resetServerIdentity: true }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(update).not.toHaveBeenCalled()
    releaseSwitch()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument())
  })

  it('requires explicit confirmation before clearing a changed canonical identity', async () => {
    const changed = { ...alpha, lastConnectionError: 'Server identity changed from server-alpha to server-new.' }
    useAppStore.setState({ profiles: [changed] })
    list.mockResolvedValue([{ ...changed, serverIdentity: null, lastConnectionError: null }])
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Edit Alpha' }))
    const confirmation = screen.getByLabelText(/I confirm this URL may establish a new server identity/)
    expect(confirmation).not.toBeChecked()
    await user.click(confirmation)
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(switchServer).toHaveBeenCalledWith('alpha', true, { resetServerIdentity: true }))
    expect(update).not.toHaveBeenCalled()
  })

  it('tracks a successful server switch from the Use button', async () => {
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Use Beta' }))

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('server_switched', { success: true }))
  })

  it('tracks a failed server switch when activation does not take effect', async () => {
    switchServer.mockResolvedValueOnce(false)
    useAppStore.setState({ profiles: [alpha, beta] })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Use Beta' }))

    await waitFor(() => expect(trackEvent).toHaveBeenCalledWith('server_switched', { success: false }))
  })
})
