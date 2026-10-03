import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Surface } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { SurfaceStack } from './SurfacePane'

vi.mock('./TerminalSurface', () => ({ TerminalSurface: () => <div data-testid="terminal" /> }))
vi.mock('./BrowserSurface', () => ({ BrowserSurface: () => <div data-testid="browser" /> }))

const base = { folder: 'General', cwd: null, url: null, page_title: null, created_at: '', updated_at: '' }
const terminal: Surface = { ...base, id: 'term_1', kind: 'terminal', name: null, cwd: '/work/app' }
const browser: Surface = { ...base, id: 'browser_1', kind: 'browser', name: 'Docs', url: 'https://docs.python.org/3/', page_title: 'Python Docs' }
const updateSurface = vi.fn()

beforeEach(() => {
  updateSurface.mockReset()
  useAppStore.setState({ updateSurface })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SurfaceStack', () => {
  it('keeps every tab mounted and shows only the selected one', () => {
    render(<SurfaceStack surfaces={[terminal, browser]} selectedId="browser_1" sidebarVisible onSidebarToggle={() => undefined} />)
    expect(screen.getByTestId('terminal').closest('.surface-pane')).not.toBeVisible()
    expect(screen.getByTestId('browser').closest('.surface-pane')).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Rename Docs' })).toHaveValue('Docs')
    expect(screen.getByText('docs.python.org')).toBeInTheDocument()
  })

  it('saves a new title on Enter, and an emptied field clears the rename', () => {
    render(<SurfaceStack surfaces={[terminal, browser]} selectedId="browser_1" sidebarVisible onSidebarToggle={() => undefined} />)
    const title = screen.getByRole('textbox', { name: 'Rename Docs' })
    fireEvent.change(title, { target: { value: ' Python ' } })
    fireEvent.keyDown(title, { key: 'Enter' })
    fireEvent.blur(title)
    expect(updateSurface).toHaveBeenCalledWith('browser_1', { name: 'Python' })

    fireEvent.change(title, { target: { value: '' } })
    fireEvent.blur(title)
    expect(updateSurface).toHaveBeenCalledWith('browser_1', { name: null })
  })

  it('leaves the record alone when the default title is cleared, and restores it', () => {
    render(<SurfaceStack surfaces={[terminal]} selectedId="term_1" sidebarVisible onSidebarToggle={() => undefined} />)
    const title = screen.getByRole('textbox', { name: 'Rename Terminal' })
    fireEvent.change(title, { target: { value: '' } })
    fireEvent.blur(title)
    expect(updateSurface).not.toHaveBeenCalled()
    expect(title).toHaveValue('Terminal')
  })

  it('focuses the title for editing when the sidebar asks to rename this tab', async () => {
    render(<SurfaceStack surfaces={[terminal, browser]} selectedId="term_1" sidebarVisible onSidebarToggle={() => undefined} />)
    act(() => { window.dispatchEvent(new CustomEvent('agentsdock:rename-surface', { detail: { surfaceId: 'term_1' } })) })
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
    expect(screen.getByRole('textbox', { name: 'Rename Terminal' })).toHaveFocus()
  })
})
