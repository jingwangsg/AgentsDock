import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppErrorBoundary } from './AppErrorBoundary'

function Broken(): never {
  throw new Error('boom from render')
}

describe('AppErrorBoundary', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('renders children while nothing throws', () => {
    render(<AppErrorBoundary><span>fine</span></AppErrorBoundary>)
    expect(screen.getByText('fine')).toBeInTheDocument()
  })

  it('replaces a crashed tree with the error, its stack and a reload button instead of a blank window', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>)

    expect(screen.getByRole('alert')).toHaveTextContent('AgentsDock hit an error')
    expect(screen.getByRole('alert')).toHaveTextContent('boom from render')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })
})
