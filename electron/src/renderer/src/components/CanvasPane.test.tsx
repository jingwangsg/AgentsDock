import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Session } from '@shared/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasPane, canvasWidthStorageKey } from './CanvasPane'

const fixture = vi.hoisted(() => ({ state: { activeProfileId: 'profile', profileGeneration: 1, drafts: {} } }))
vi.mock('../store/app-store', () => ({ useAppStore: Object.assign(
  (selector: (state: typeof fixture.state) => unknown) => selector(fixture.state), { getState: () => fixture.state }) }))

const session = { id: 'chat-1' } as Session
const target = { sessionId: 'chat-1', name: 'report' }

function renderCanvas(workspaceKey = 'server:alpha') {
  const host = document.body.appendChild(document.createElement('section'))
  const view = render(<CanvasPane workspaceKey={workspaceKey} session={session} target={target} onClose={() => {}} />, { container: host })
  const pane = screen.getByRole('region', { name: 'Canvas' })
  const userWidth = () => host.style.getPropertyValue('--canvas-pane-user-width')
  // jsdom has no layout: apply CanvasPane.css's clamp for a 1000px conversation pane (default 52% = 520px).
  vi.spyOn(pane, 'getBoundingClientRect').mockImplementation(() =>
    ({ width: Math.min(Math.max(Number.parseFloat(userWidth()) || 520, 280), 1000 - 360) }) as DOMRect)
  return { ...view, userWidth, handle: screen.getByRole('separator', { name: 'Resize Canvas' }) }
}

beforeEach(() => {
  // jsdom lacks pointer capture; Chromium provides it.
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
  const pending = () => new Promise(() => {})
  vi.stubGlobal('agentsDock', { canvas: { list: vi.fn(pending), get: vi.fn(pending), putState: vi.fn() } })
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe('CanvasPane width', () => {
  it('restores the saved width and drops it, with any drag state, on close', () => {
    localStorage.setItem(canvasWidthStorageKey('server:alpha'), '600')
    const { handle, userWidth, unmount } = renderCanvas()
    expect(userWidth()).toBe('600px')

    fireEvent.pointerDown(handle, { pointerId: 3, clientX: 900 })
    expect(document.body).toHaveClass('canvas-resizing')
    unmount()

    expect(userWidth()).toBe('')
    expect(document.body).not.toHaveClass('canvas-resizing')
  })

  it('widens when the left edge is dragged left and stores the width that rendered after the clamp', () => {
    const { handle, userWidth } = renderCanvas()

    fireEvent.pointerDown(handle, { pointerId: 3, clientX: 900 })
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 800 })
    expect(userWidth()).toBe('620px')
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 500 })
    expect(userWidth()).toBe('920px')

    fireEvent.pointerUp(handle, { pointerId: 3, clientX: 500 })
    expect(userWidth()).toBe('640px')
    expect(localStorage.getItem(canvasWidthStorageKey('server:alpha'))).toBe('640')
    expect(document.body).not.toHaveClass('canvas-resizing')
  })

  it('resizes from the keyboard and resets to the default width on double-click', () => {
    const { handle, userWidth } = renderCanvas()

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(userWidth()).toBe('536px')
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })
    expect(localStorage.getItem(canvasWidthStorageKey('server:alpha'))).toBe('496')

    fireEvent.doubleClick(handle)
    expect(userWidth()).toBe('')
    expect(localStorage.getItem(canvasWidthStorageKey('server:alpha'))).toBeNull()
  })
})
