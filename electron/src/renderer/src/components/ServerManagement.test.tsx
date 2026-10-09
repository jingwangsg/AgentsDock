import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { PublicServerProfile, ServerUpdateAllProgress } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { trackEvent } from '../lib/analytics'
import { ServerManagement, serverOrderAfterDrag } from './ServerManagement'

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
  const remoteMove = vi.fn()
  const remoteRedeploy = vi.fn()
  const remoteUpdateAll = vi.fn()
  const progressListeners = new Set<(value: ServerUpdateAllProgress) => void>()
  const pairingUrl = vi.fn()
  const copyToken = vi.fn()
  const startLocalServer = vi.fn()
  const restartLocalServer = vi.fn()
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
    remoteMove.mockReset().mockResolvedValue(undefined)
    remoteRedeploy.mockReset()
    remoteUpdateAll.mockReset()
    progressListeners.clear()
    pairingUrl.mockReset().mockResolvedValue('http://nvmac.tail46daa8.ts.net:7850')
    copyToken.mockReset().mockResolvedValue(true)
    startLocalServer.mockReset().mockResolvedValue(undefined)
    restartLocalServer.mockReset()
    switchServer.mockReset().mockImplementation(async (profileId: string) => {
      useAppStore.setState(state => ({ activeProfileId: profileId, profileGeneration: state.profileGeneration + 1 }))
      return true
    })
    Object.defineProperty(window, 'agentsDock', {
      configurable: true,
      value: {
        servers: { list, update, remove, reorder },
        remoteServers: { deploy: remoteDeploy, attach: remoteAttach, cancel: remoteCancel, remove: remoteRemove, move: remoteMove, redeploy: remoteRedeploy, updateAll: remoteUpdateAll },
        hub: { pairingUrl, copyToken, startLocalServer, restartLocalServer },
        events: { on: (name: string, listener: (value: ServerUpdateAllProgress) => void) => {
          if (name !== 'remote-servers:update-all-progress') return () => undefined
          progressListeners.add(listener)
          return () => progressListeners.delete(listener)
        } }
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
    expect(remoteDeploy).toHaveBeenCalledWith({ sshHost: 'nv_gb300', installDir: '~/.agentsdock-server', name: undefined })
    expect(useAppStore.getState().profiles.map(profile => profile.id)).toEqual(['hub', 'osmo', 'gb300'])
    expect(trackEvent).toHaveBeenCalledWith('server_added', { success: true })
    expect(screen.queryByRole('button', { name: 'Add & switch' })).not.toBeInTheDocument()
  })

  it('sends the typed password with the deploy so the hub can install its SSH key', async () => {
    list.mockResolvedValue([hub, osmo, gb300])
    useAppStore.setState({ profiles: [hub, osmo], activeProfileId: hub.id })
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('SSH host'), 'dev@build-host')
    await user.type(screen.getByLabelText('Password (optional)'), 'hunter2')
    await user.click(screen.getByRole('button', { name: 'Add & switch' }))

    await waitFor(() => expect(remoteDeploy).toHaveBeenCalledWith({ sshHost: 'dev@build-host', installDir: '~/.agentsdock-server', name: undefined, password: 'hunter2' }))
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
    expect(remoteAttach).toHaveBeenCalledWith({ sshHost: 'nv_gb300', installDir: '/mnt/lustre/.agentsdock-server', name: undefined })
    expect(remoteDeploy).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeProfileId).toBe('gb300')
    expect(screen.queryByRole('button', { name: 'Add & switch' })).not.toBeInTheDocument()
  })

  it('does not move a just-added remote when Save follows a failed switch', async () => {
    list.mockResolvedValue([hub, gb300])
    useAppStore.setState({ profiles: [hub], activeProfileId: hub.id })
    switchServer.mockResolvedValueOnce(false)
    const user = userEvent.setup()
    render(<ServerManagement addRequest={1} />)

    await user.type(screen.getByLabelText('SSH host'), 'nv_gb300')
    await user.click(screen.getByRole('button', { name: 'Add & switch' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not switch to it')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull())
    expect(remoteMove).not.toHaveBeenCalled()
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

  it('forwards SSH for a remote under its server name and turns it off again', async () => {
    list.mockResolvedValue([hub, osmo])
    useAppStore.setState({ profiles: [hub, osmo], activeProfileId: hub.id })
    const user = userEvent.setup()
    const view = render(<ServerManagement />)

    expect(screen.queryByRole('button', { name: /Forward SSH as This Mac/ })).toBeNull() // a direct server has no SSH host
    await user.click(screen.getByRole('button', { name: 'Forward SSH as OSMO' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('osmo', { sshForward: true }))

    useAppStore.setState({ profiles: [hub, { ...osmo, sshForward: true }] })
    view.rerender(<ServerManagement />)
    const on = screen.getByRole('button', { name: 'Stop forwarding SSH as OSMO' })
    expect(on).toHaveAttribute('aria-pressed', 'true')
    await user.click(on)
    await waitFor(() => expect(update).toHaveBeenCalledWith('osmo', { sshForward: false }))
  })

  it('removes a hub-managed remote through the hub and refreshes the list', async () => {
    list.mockResolvedValue([hub])
    useAppStore.setState({ profiles: [hub, osmo], activeProfileId: hub.id })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Remove OSMO' }))
    expect(remoteRemove).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Remove OSMO' }))

    await waitFor(() => expect(remoteRemove).toHaveBeenCalledWith('osmo'))
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

  it('restarts the local server from its row, asking first when its chats are running', async () => {
    let finish: () => void = () => {}
    restartLocalServer.mockImplementation(async (force: boolean) => force
      ? new Promise(resolve => { finish = () => resolve({ restarted: true, running: 0 }) })
      : { restarted: false, running: 2 })
    let finishRedeploy: () => void = () => {}
    remoteRedeploy.mockImplementation(() => new Promise(resolve => { finishRedeploy = () => resolve({ redeployed: true, running: 0 }) }))
    useAppStore.setState({ profiles: [hub, osmo], activeProfileId: osmo.id })
    const user = userEvent.setup()
    const { rerender } = render(<ServerManagement />)
    expect(screen.queryByRole('button', { name: 'Restart OSMO' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Restart This Mac' }))
    expect(await screen.findByText('2 running chats will stop.')).toBeInTheDocument()
    expect(restartLocalServer).toHaveBeenCalledExactlyOnceWith(false)
    // A remote's redeploy is a hub job the restart would end.
    await user.click(screen.getByRole('button', { name: 'Redeploy OSMO' }))
    expect(screen.getByRole('button', { name: 'Restart anyway' })).toBeDisabled()
    act(() => finishRedeploy())
    expect(await screen.findByText('Redeployed.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restart anyway' }))
    await waitFor(() => expect(restartLocalServer).toHaveBeenLastCalledWith(true))

    // The restart ends hub jobs, and the hub reads offline while it is down: nothing else starts, and no Start appears.
    expect(screen.getByRole('button', { name: 'Redeploy OSMO' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Update & redeploy all' })).toBeDisabled()
    act(() => useAppStore.setState({ profiles: [{ ...hub, connectionState: 'retrying' as const }, osmo] }))
    rerender(<ServerManagement />)
    expect(screen.queryByRole('button', { name: 'Start This Mac' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Restart This Mac' })).toBeDisabled()

    act(() => finish())
    expect(await screen.findByText('Restarted.')).toBeInTheDocument()
  })

  it('updates and redeploys all servers after confirming their running chats, showing each server\'s step', async () => {
    let finish: () => void = () => {}
    const emit = (value: ServerUpdateAllProgress) => act(() => progressListeners.forEach(listener => listener(value)))
    remoteUpdateAll.mockImplementation(async (force: boolean) => force
      ? new Promise(resolve => { finish = () => resolve([]) })
      : [{ name: 'This Mac', running: 2 }, { name: 'OSMO', running: null }])
    remoteRedeploy.mockResolvedValue({ redeployed: false, running: 1 })
    useAppStore.setState({ profiles: [hub, osmo, gb300], activeProfileId: osmo.id })
    const user = userEvent.setup()
    render(<ServerManagement />)
    await user.click(screen.getByRole('button', { name: 'Redeploy GB300' }))
    expect(await screen.findByRole('button', { name: 'Redeploy anyway' })).toBeInTheDocument()

    // A row's earlier confirmation goes, so it cannot start a redeploy during the run.
    await user.click(screen.getByRole('button', { name: 'Update & redeploy all' }))
    expect(screen.queryByRole('button', { name: 'Redeploy anyway' })).toBeNull()
    expect(await screen.findByText("Running chats will stop on: This Mac (2), OSMO (couldn't check).")).toBeInTheDocument()
    expect(remoteUpdateAll).toHaveBeenCalledExactlyOnceWith(false)
    await user.click(screen.getByRole('button', { name: 'Update anyway' }))
    await waitFor(() => expect(remoteUpdateAll).toHaveBeenLastCalledWith(true))
    expect(screen.queryByText(/Running chats will stop/)).toBeNull()

    emit({ profileId: 'hub', step: 'restart' })
    expect(screen.getByText('Restarting…')).toBeInTheDocument()
    // Nothing else may start a redeploy or CLI update meanwhile.
    expect(screen.getByRole('button', { name: 'Redeploy GB300' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Update a CLI on OSMO' })).toBeDisabled()
    emit({ profileId: 'hub', step: 'codex' })
    emit({ profileId: 'osmo', step: 'redeploy', message: 'Uploading AgentsServer source to osmo_9000…' })
    emit({ profileId: 'gb300', step: 'done', failed: true, message: 'ssh: connect to host nv_gb300: Connection refused' })
    expect(screen.getByText('Updating Codex…')).toBeInTheDocument()
    expect(screen.getByText('Uploading AgentsServer source to osmo_9000…')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('ssh: connect to host nv_gb300: Connection refused')

    emit({ profileId: 'hub', step: 'done', failed: false, message: '2.1.300 (Claude Code) · codex-cli 0.161.0' })
    emit({ profileId: 'osmo', step: 'done', failed: false, message: '2.1.300 (Claude Code) · codex-cli 0.161.0' })
    await act(async () => finish())
    expect(screen.getAllByText('2.1.300 (Claude Code) · codex-cli 0.161.0')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Update & redeploy all' })).toBeEnabled()
    // The listener is gone once the run ends.
    expect(progressListeners.size).toBe(0)
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

  it('shows remotes by SSH host, never offers to delete the hub, and adds remotes from any server', () => {
    useAppStore.setState({ profiles: [hub, osmo, gb300], activeProfileId: hub.id })
    render(<ServerManagement />)

    expect(screen.getByText('osmo_9000')).toBeInTheDocument()
    expect(screen.getByText('nv_gb300')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove This Mac|Cannot remove active server This Mac/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Remove OSMO' })).toBeEnabled()

    act(() => useAppStore.setState({ activeProfileId: osmo.id }))

    expect(screen.getByRole('button', { name: 'Add server' })).toBeEnabled()
    // Removing goes through the hub from any server; the active remote after switching to the hub.
    expect(screen.getByRole('button', { name: 'Remove GB300' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Remove OSMO' })).toHaveAttribute('title', 'Switch to This Mac and remove this server')
    expect(screen.queryByRole('button', { name: /Remove This Mac|Cannot remove active server This Mac/ })).not.toBeInTheDocument()
  })

  it('cannot add a remote without the local server that keeps its connection', () => {
    useAppStore.setState({ profiles: [osmo], activeProfileId: osmo.id })
    render(<ServerManagement />)

    expect(screen.queryByRole('button', { name: 'Update & redeploy all' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add server' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add server' })).toHaveAttribute('title', 'Remote servers are added through the local server; add it first.')
  })

  it('removes the active remote after switching to the hub', async () => {
    list.mockResolvedValue([hub])
    useAppStore.setState({ profiles: [hub, osmo], activeProfileId: osmo.id })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Remove OSMO' }))
    await user.click(screen.getByRole('button', { name: 'Remove OSMO' }))

    await waitFor(() => expect(remoteRemove).toHaveBeenCalledWith('osmo'))
    expect(switchServer).toHaveBeenCalledWith('hub')
    expect(switchServer.mock.invocationCallOrder[0]).toBeLessThan(remoteRemove.mock.invocationCallOrder[0])
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

  it('offers Start only while the local server is down and Restart only while it is up, and shows why a start failed', async () => {
    const down = { ...hub, connectionState: 'offline' as const, lastConnectionError: 'fetch failed' }
    useAppStore.setState({ profiles: [down, osmo], activeProfileId: hub.id })
    startLocalServer.mockRejectedValueOnce(new Error('No AgentsServer LaunchAgent in /Users/me/Library/LaunchAgents'))
    const user = userEvent.setup()
    const { rerender } = render(<ServerManagement />)

    expect(screen.queryByRole('button', { name: 'Start OSMO' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restart This Mac' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start This Mac' }))
    expect(await screen.findByText('No AgentsServer LaunchAgent in /Users/me/Library/LaunchAgents')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Start This Mac' }))
    await waitFor(() => expect(startLocalServer).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('fetch failed')).toBeInTheDocument()

    act(() => useAppStore.setState({ profiles: [hub, osmo] }))
    rerender(<ServerManagement />)
    expect(screen.queryByRole('button', { name: 'Start This Mac' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restart This Mac' })).toBeInTheDocument()
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
    // Another host's /api/remote/ path is a plain saved server, not one of this hub's remotes.
    useAppStore.setState({ profiles: [alpha, hub, { ...beta, serverUrl: 'https://beta.example:7850/api/remote/b1' }] })
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

  it('offers a drag grip on every server but the pinned local one, and no arrows', () => {
    useAppStore.setState({ profiles: [alpha, hub, beta] })
    render(<ServerManagement />)

    expect(screen.queryByRole('button', { name: /Move .* (up|down)/ })).toBeNull()
    const grips = screen.getAllByRole('button', { name: /Drag .* to reorder/ })
    expect(grips.map(grip => grip.getAttribute('aria-label'))).toEqual(['Drag This Mac to reorder', 'Drag Alpha to reorder', 'Drag Beta to reorder'])
    expect(grips[0]).toHaveClass('pinned')
    expect(grips[0]).toBeDisabled()
    expect(grips[1]).toBeEnabled()
  })

  it('computes the saved order after a drag with the local server kept first', () => {
    const profiles = [hub, alpha, beta, gamma]
    expect(serverOrderAfterDrag(profiles, hub.id, 'gamma', 'alpha')).toEqual(['hub', 'gamma', 'alpha', 'beta'])
    expect(serverOrderAfterDrag(profiles, hub.id, 'alpha', 'gamma')).toEqual(['hub', 'beta', 'gamma', 'alpha'])
    // Dropping onto the local server or onto itself changes nothing.
    expect(serverOrderAfterDrag(profiles, hub.id, 'beta', 'hub')).toBeNull()
    expect(serverOrderAfterDrag(profiles, hub.id, 'beta', 'beta')).toBeNull()
    expect(serverOrderAfterDrag([alpha, beta], null, 'beta', 'alpha')).toEqual(['beta', 'alpha'])
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

  it('moves a hub remote only when its edit form gets a new SSH host or install directory', async () => {
    useAppStore.setState({ profiles: [hub, gb300], activeProfileId: hub.id })
    list.mockResolvedValue([hub, gb300])
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Edit GB300' }))
    expect(screen.getByLabelText('SSH host')).toHaveValue('nv_gb300')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    // Nothing moved: the remote stays where it is.
    await waitFor(() => expect(screen.queryByLabelText('SSH host')).toBeNull())
    expect(remoteMove).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Edit GB300' }))
    await user.clear(screen.getByLabelText('SSH host'))
    await user.type(screen.getByLabelText('SSH host'), 'oci@new-cluster')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(remoteMove).toHaveBeenCalledExactlyOnceWith('gb300', { sshHost: 'oci@new-cluster', installDir: undefined }))
    await waitFor(() => expect(screen.queryByLabelText('SSH host')).toBeNull())
    expect(update).not.toHaveBeenCalled()
  })

  it('shows no SSH host or install directory when editing the local server', async () => {
    useAppStore.setState({ profiles: [hub, gb300], activeProfileId: hub.id })
    const user = userEvent.setup()
    render(<ServerManagement />)

    await user.click(screen.getByRole('button', { name: 'Edit This Mac' }))
    expect(screen.getByLabelText('Name on this Mac')).toHaveValue('This Mac')
    expect(screen.queryByLabelText('SSH host')).toBeNull()
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
