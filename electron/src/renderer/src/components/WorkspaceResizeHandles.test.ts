import { afterEach, describe, expect, it } from 'vitest'
import {
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  REVIEW_MAX_WIDTH,
  REVIEW_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampWorkspacePanelWidth,
  persistWorkspaceSidebarVisible,
  savedWorkspaceColumnStyle,
  savedWorkspaceSidebarVisible
} from './WorkspaceResizeHandles'

afterEach(() => localStorage.clear())

describe('clampWorkspacePanelWidth', () => {
  it('persists sidebar visibility as one app setting', () => {
    expect(savedWorkspaceSidebarVisible()).toBe(true)

    persistWorkspaceSidebarVisible(false)

    expect(savedWorkspaceSidebarVisible()).toBe(false)
  })

  it('keeps both docked panels from crushing the conversation', () => {
    expect(clampWorkspacePanelWidth('sidebar', 900, 1440, 400, true)).toBe(460)
    expect(clampWorkspacePanelWidth('inspector', 900, 1200, 300, true)).toBe(380)
  })

  it('allows a wider overlaid inspector on compact windows', () => {
    expect(clampWorkspacePanelWidth('inspector', 620, 1000, 230, true)).toBe(620)
  })

  it('honors each panel minimum and maximum', () => {
    expect(clampWorkspacePanelWidth('sidebar', 10, 2000, 350, true)).toBe(SIDEBAR_MIN_WIDTH)
    expect(clampWorkspacePanelWidth('sidebar', 900, 2000, 350, false)).toBe(SIDEBAR_MAX_WIDTH)
    expect(clampWorkspacePanelWidth('inspector', 10, 2000, 282, true)).toBe(INSPECTOR_MIN_WIDTH)
    expect(clampWorkspacePanelWidth('inspector', 900, 2000, 282, true)).toBe(INSPECTOR_MAX_WIDTH)
    expect(clampWorkspacePanelWidth('review', 10, 2200, 282, true)).toBe(REVIEW_MIN_WIDTH)
    expect(clampWorkspacePanelWidth('review', 1400, 2200, 282, true)).toBe(REVIEW_MAX_WIDTH)
  })

  it('keeps a docked review wide without covering the conversation', () => {
    expect(clampWorkspacePanelWidth('review', 900, 1440, 282, true)).toBe(638)
    expect(clampWorkspacePanelWidth('review', 820, 1728, 282, true)).toBe(820)
  })

  it('restores the saved sidebar, inspector, and review widths', () => {
    localStorage.setItem('agentsdock:sidebar-width', '320')
    localStorage.setItem('agentsdock:inspector-width', '420')
    localStorage.setItem('agentsdock:review-width', '750')

    expect(savedWorkspaceColumnStyle(2000)).toMatchObject({
      '--sidebar-width': '320px',
      '--inspector-width': '420px',
      '--review-width': '750px'
    })
  })
})
