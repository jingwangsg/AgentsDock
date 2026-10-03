import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsDockAPI } from '@shared/ipc'
import type { Surface } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { BrowserSurface } from './BrowserSurface'

const surface: Surface = { id: 'browser_abc', kind: 'browser', name: null, folder: 'General', cwd: null, url: null, page_title: null, created_at: '', updated_at: '' }

beforeEach(() => {
  Object.defineProperty(window, 'agentsDock', {
    configurable: true,
    value: { native: { openExternal: vi.fn() }, surfaces: { prepareBrowser: vi.fn().mockResolvedValue('persist:browser-server-test') } } as unknown as AgentsDockAPI
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** jsdom renders <webview> as an unknown element; give it the methods the tab calls. */
function webviewStub(container: HTMLElement) {
  const view = container.querySelector('webview') as HTMLElement & Record<string, any>
  view.loadURL = vi.fn().mockResolvedValue(undefined)
  view.canGoBack = vi.fn(() => true)
  view.canGoForward = vi.fn(() => false)
  view.goBack = vi.fn()
  view.reload = vi.fn()
  return view
}

describe('BrowserSurface', () => {
  it('starts blank with the address bar focused and loads what is typed', async () => {
    const { container } = render(<BrowserSurface surface={surface} active />)
    expect(container.querySelector('webview')).toBeNull()
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    const view = webviewStub(container)
    expect(view.getAttribute('src')).toBe('about:blank')
    expect(view.getAttribute('partition')).toBe('persist:browser-server-test')
    expect(window.agentsDock.surfaces.prepareBrowser).toHaveBeenCalledWith(surface.id)
    expect(screen.getByText('Enter an address above to open a page.')).toBeInTheDocument()
    const address = screen.getByRole('textbox', { name: 'Address' })
    expect(address).toHaveFocus()

    fireEvent.change(address, { target: { value: 'docs.python.org' } })
    fireEvent.submit(address.closest('form')!)
    expect(view.loadURL).toHaveBeenCalledWith('https://docs.python.org')
  })

  it('follows navigation and titles into the tab record and reports a failed load', async () => {
    const updateSurface = vi.fn()
    useAppStore.setState({ updateSurface })
    const { container } = render(<BrowserSurface surface={surface} active />)
    await waitFor(() => expect(container.querySelector('webview')).not.toBeNull())
    const view = webviewStub(container)

    act(() => { view.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.com/page' })) })
    expect(updateSurface).toHaveBeenCalledWith('browser_abc', { url: 'https://example.com/page' })
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('https://example.com/page')
    expect(screen.queryByText('Enter an address above to open a page.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()

    act(() => { view.dispatchEvent(Object.assign(new Event('page-title-updated'), { title: 'Example Domain' })) })
    expect(updateSurface).toHaveBeenCalledWith('browser_abc', { page_title: 'Example Domain' })

    act(() => { view.dispatchEvent(Object.assign(new Event('did-fail-load'), { errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedURL: 'https://nope.invalid/', isMainFrame: true })) })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load https://nope.invalid/: ERR_NAME_NOT_RESOLVED')
    // A navigation superseded by a newer one is not a failure.
    act(() => { view.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.com/next' })) })
    act(() => { view.dispatchEvent(Object.assign(new Event('did-fail-load'), { errorCode: -3, isMainFrame: true })) })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Open in default browser' }))
    expect(window.agentsDock.native.openExternal).toHaveBeenCalledWith('https://example.com/next')
  })

  it('does not navigate through the local machine when remote setup fails', async () => {
    vi.mocked(window.agentsDock.surfaces.prepareBrowser).mockRejectedValue(new Error('Server disconnected'))
    const { container } = render(<BrowserSurface surface={{ ...surface, url: 'http://localhost:8265/' }} active />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Server disconnected')
    expect(container.querySelector('webview')).toBeNull()
    vi.mocked(window.agentsDock.surfaces.prepareBrowser).mockResolvedValue('persist:reconnected-server')
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(container.querySelector('webview')?.getAttribute('partition')).toBe('persist:reconnected-server'))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
