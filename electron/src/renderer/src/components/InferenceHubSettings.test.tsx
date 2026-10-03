import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import { setLocale } from '@shared/i18n'
import type { InferenceProxyStatus } from '@shared/types'
import { InferenceHubSettings } from './InferenceHubSettings'

const PLIST = '/home/me/Library/LaunchAgents/com.agentsdock.inference-proxy.plist'
const snapshot = (overrides: Partial<InferenceProxyStatus> = {}): InferenceProxyStatus => ({
  port: 20001, upstreamBaseUrl: 'https://inference-api.nvidia.com/v1/', baseUrl: 'http://127.0.0.1:20001/v1', hasProxyToken: true,
  keys: [{ name: 'yam-00', enabled: true, hint: 'ab12' }], service: 'running', healthy: true, localHubInstalled: true, hubForwardPort: 20001,
  configFile: '/home/me/.config/yam-api-proxy/config.json', plistFile: PLIST, ...overrides
})

function bridge(initial = snapshot(), overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const inferenceProxy = {
    status: vi.fn().mockResolvedValue(initial), setPort: vi.fn().mockResolvedValue(initial), addKey: vi.fn().mockResolvedValue(initial),
    removeKey: vi.fn().mockResolvedValue(initial), setKeyEnabled: vi.fn().mockResolvedValue(initial), start: vi.fn().mockResolvedValue(initial),
    stop: vi.fn().mockResolvedValue(initial), copyProxyToken: vi.fn().mockResolvedValue(true), ...overrides
  }
  const native = { writeClipboard: vi.fn().mockResolvedValue(undefined) }
  Object.defineProperty(window, 'agentsDock', { configurable: true, value: { inferenceProxy, native } as unknown as AgentsDockAPI })
  return { inferenceProxy, native }
}

describe('InferenceHubSettings', () => {
  beforeEach(() => setLocale('en'))
  afterEach(cleanup)

  it('shows the proxy state, endpoint, remote forwarding and keys without exposing key material', async () => {
    bridge()
    render(<InferenceHubSettings />)
    expect(await screen.findByText('Running on 127.0.0.1:20001')).toBeInTheDocument()
    expect(screen.getByText('http://127.0.0.1:20001/v1')).toBeInTheDocument()
    expect(screen.getByText('https://inference-api.nvidia.com/v1/')).toBeInTheDocument()
    expect(screen.getByText('The local server is set to forward each remote server’s 127.0.0.1:20001 to this proxy. It applies after the local server restarts.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()
    expect(screen.getByText('yam-00')).toBeInTheDocument()
    expect(screen.getByText('••••ab12')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Enable yam-00' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('still shows the loaded state under StrictMode, which mounts, unmounts and mounts again', async () => {
    const { inferenceProxy } = bridge()
    render(<StrictMode><InferenceHubSettings /></StrictMode>)
    expect(await screen.findByText('Running on 127.0.0.1:20001')).toBeInTheDocument()
    expect(inferenceProxy.status).toHaveBeenCalled()
  })

  it('adds a key through the main process and clears the inputs on success', async () => {
    const added = snapshot({ keys: [{ name: 'yam-00', enabled: true, hint: 'ab12' }, { name: 'yam-11', enabled: true, hint: 'wxyz' }] })
    const { inferenceProxy } = bridge(snapshot(), { addKey: vi.fn().mockResolvedValue(added) })
    render(<InferenceHubSettings />)
    await screen.findByText('yam-00')
    const name = screen.getByLabelText('Name') as HTMLInputElement
    const key = screen.getByLabelText('API key') as HTMLInputElement
    fireEvent.change(name, { target: { value: ' yam-11 ' } })
    fireEvent.change(key, { target: { value: 'nvapi-secret-wxyz' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add key' }))
    expect(inferenceProxy.addKey).toHaveBeenCalledExactlyOnceWith('yam-11', 'nvapi-secret-wxyz')
    expect(await screen.findByText('yam-11')).toBeInTheDocument()
    expect(screen.getByText('••••wxyz')).toBeInTheDocument()
    expect(name.value).toBe('')
    expect(key.value).toBe('')
    expect(document.body.textContent).not.toContain('nvapi-secret-wxyz')
  })

  it('saves a changed port, tells the user to restart the local server, and drops that notice on the next request', async () => {
    const saved = snapshot({ port: 20002, baseUrl: 'http://127.0.0.1:20002/v1', hubForwardPort: 20002 })
    const { inferenceProxy } = bridge(snapshot(), { setPort: vi.fn().mockResolvedValue(saved), stop: vi.fn().mockResolvedValue({ ...saved, service: 'stopped', healthy: false }) })
    render(<InferenceHubSettings />)
    const port = await screen.findByLabelText('Port') as HTMLInputElement
    expect(port.value).toBe('20001')
    fireEvent.change(port, { target: { value: '99' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.change(port, { target: { value: '20002' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(inferenceProxy.setPort).toHaveBeenCalledExactlyOnceWith(20002)
    expect(await screen.findByText('Port saved. Restart the local server (Settings → Server) so remote servers forward port 20002.')).toBeInTheDocument()
    expect(screen.getByText('http://127.0.0.1:20002/v1')).toBeInTheDocument()
    expect(port.value).toBe('20002')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByText('Stopped')).toBeInTheDocument()
    expect(screen.queryByText(/^Port saved\./)).not.toBeInTheDocument()
  })

  it('offers Start when stopped and Enable when the local hub does not forward the port', async () => {
    const { inferenceProxy } = bridge(snapshot({ service: 'stopped', healthy: false, hubForwardPort: null }))
    render(<InferenceHubSettings />)
    expect(await screen.findByText('Stopped')).toBeInTheDocument()
    expect(screen.getByText('Not forwarded yet: the local server has no inference proxy port configured.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    expect(inferenceProxy.setPort).toHaveBeenCalledExactlyOnceWith(20001)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(inferenceProxy.start).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
  })

  it('explains a missing service and a hub forwarding another port', async () => {
    bridge(snapshot({ service: 'not-installed', healthy: false, hubForwardPort: 8788 }))
    render(<InferenceHubSettings />)
    expect(await screen.findByText(`Not installed: no LaunchAgent at ${PLIST}`)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Start|Stop)$/ })).not.toBeInTheDocument()
    expect(screen.getByText('The local server is set to port 8788; save the port again to update it.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeEnabled()
  })

  it('says so when no local server is installed instead of offering to enable forwarding', async () => {
    bridge(snapshot({ localHubInstalled: false, hubForwardPort: null }))
    render(<InferenceHubSettings />)
    expect(await screen.findByText('No local server is installed on this machine, so there are no remote servers to forward to.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()
  })

  it('toggles and removes keys, and reports a failure without losing the current state or an unsaved port edit', async () => {
    const { inferenceProxy } = bridge(snapshot(), { removeKey: vi.fn().mockRejectedValue(new Error('No key named yam-00.')) })
    render(<InferenceHubSettings />)
    const toggle = await screen.findByRole('checkbox', { name: 'Enable yam-00' })
    const port = screen.getByLabelText('Port') as HTMLInputElement
    fireEvent.change(port, { target: { value: '20002' } })
    fireEvent.click(toggle)
    expect(inferenceProxy.setKeyEnabled).toHaveBeenCalledExactlyOnceWith('yam-00', false)
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(port.value).toBe('20002')
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Remove yam-00' }))
    expect(inferenceProxy.removeKey).toHaveBeenCalledExactlyOnceWith('yam-00')
    expect(await screen.findByRole('alert')).toHaveTextContent('No key named yam-00.')
    // The failure may have happened after the config was written, so the page re-reads the real state.
    await waitFor(() => expect(inferenceProxy.status).toHaveBeenCalledTimes(2))
    expect(screen.getByText('yam-00')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled()
  })

  it('copies the endpoint from the renderer and the proxy token inside the main process', async () => {
    const { inferenceProxy, native } = bridge()
    render(<InferenceHubSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Copy proxy token' }))
    expect(inferenceProxy.copyProxyToken).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy proxy token' })).toHaveTextContent('Copied'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy endpoint' }))
    expect(native.writeClipboard).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:20001/v1')
    expect(document.body.textContent).not.toMatch(/[A-Za-z0-9_-]{43}/)
  })
})
