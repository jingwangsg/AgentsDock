import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeAppearance, readAppearance, readColorThemes, resolveAppearance, setAppearanceMode, setColorTheme } from './appearance'
import { COLOR_THEMES } from './color-themes.data'

describe('resolveAppearance', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete document.documentElement.dataset.appearance
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.colorTheme
    document.documentElement.removeAttribute('style')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('follows the system preference in system mode', () => {
    expect(resolveAppearance('system', true)).toBe('dark')
    expect(resolveAppearance('system', false)).toBe('light')
  })

  it('keeps explicit appearance choices stable', () => {
    expect(resolveAppearance('light', true)).toBe('light')
    expect(resolveAppearance('dark', false)).toBe('dark')
  })

  it('persists explicit choices and applies them immediately', () => {
    setAppearanceMode('light')
    expect(readAppearance()).toBe('light')
    expect(window.localStorage.getItem('agentsdock.appearance')).toBe('light')
    expect(document.documentElement.dataset).toMatchObject({ appearance: 'light', theme: 'light' })
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('defaults invalid stored values back to system mode', () => {
    window.localStorage.setItem('agentsdock.appearance', 'sepia')
    expect(readAppearance()).toBe('system')
  })

  it('applies the chosen color theme of the resolved appearance and returns to One without leftovers', () => {
    const dark = COLOR_THEMES.find(theme => theme.mode === 'dark')!
    const root = document.documentElement
    setAppearanceMode('dark')
    setColorTheme('dark', dark.id)
    expect(readColorThemes()).toEqual({ light: 'one-light', dark: dark.id })
    expect(root.dataset.colorTheme).toBe(dark.id)
    expect(root.style.getPropertyValue('--bg')).toBe(dark.ui.bg)
    setAppearanceMode('light')
    expect(root.dataset.colorTheme).toBe('one-light')
    expect(root.style.getPropertyValue('--bg')).toBe('')
  })

  it('falls back to One for a stored theme that no longer exists or belongs to the other appearance', () => {
    const light = COLOR_THEMES.find(theme => theme.mode === 'light')!
    window.localStorage.setItem('agentsdock.colorThemes', JSON.stringify({ light: 'retired-theme', dark: light.id }))
    expect(readColorThemes()).toEqual({ light: 'one-light', dark: 'one-dark' })
  })

  it('tracks a live macOS appearance change while in system mode', () => {
    let prefersDark = true
    let change: (() => void) | undefined
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      get matches() { return prefersDark },
      addEventListener: (_type: string, listener: () => void) => { change = listener },
      removeEventListener: vi.fn()
    }) as unknown as MediaQueryList))

    initializeAppearance()
    expect(document.documentElement.dataset.theme).toBe('dark')
    prefersDark = false
    change?.()
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
