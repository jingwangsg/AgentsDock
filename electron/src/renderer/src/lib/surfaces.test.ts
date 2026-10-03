import { describe, expect, it } from 'vitest'
import type { Surface } from '@shared/types'
import { browserAddressURL, surfaceSubline, surfaceTitle } from './surfaces'

const surface = (patch: Partial<Surface>): Surface => ({ id: 'x', kind: 'terminal', name: null, folder: 'General', cwd: null, url: null, page_title: null, created_at: '', updated_at: '', ...patch })

describe('browserAddressURL', () => {
  it('keeps web URLs, adds a scheme to bare hosts, and keeps loopback hosts on http', () => {
    expect(browserAddressURL(' https://example.com/a?b=1 ')).toBe('https://example.com/a?b=1')
    expect(browserAddressURL('docs.python.org/3/')).toBe('https://docs.python.org/3/')
    expect(browserAddressURL('localhost:8000')).toBe('http://localhost:8000')
    expect(browserAddressURL('127.0.0.1:7850/health')).toBe('http://127.0.0.1:7850/health')
  })

  it('searches plain words and refuses non-web schemes', () => {
    expect(browserAddressURL('ghostty terminal')).toBe('https://duckduckgo.com/?q=ghostty%20terminal')
    expect(browserAddressURL('javascript:alert(1)')).toBeNull()
    expect(browserAddressURL('file:///etc/passwd')).toBeNull()
    expect(browserAddressURL('   ')).toBeNull()
  })
})

describe('surfaceSubline', () => {
  it('shows the shell directory tail or the page host', () => {
    expect(surfaceSubline(surface({ kind: 'terminal', cwd: '/Users/me/WORKSPACE/opencli' }))).toBe('WORKSPACE / opencli')
    expect(surfaceSubline(surface({ kind: 'terminal', cwd: null }))).toBe('Terminal')
    expect(surfaceSubline(surface({ kind: 'browser', url: 'https://github.com/manaflow-ai/cmux' }))).toBe('github.com')
    expect(surfaceSubline(surface({ kind: 'browser', url: null }))).toBe('Browser')
  })
})

describe('surfaceTitle', () => {
  it('prefers the rename, then the page title, then the kind', () => {
    expect(surfaceTitle(surface({ kind: 'terminal' }))).toBe('Terminal')
    expect(surfaceTitle(surface({ kind: 'browser' }))).toBe('Browser')
    expect(surfaceTitle(surface({ kind: 'browser', page_title: 'Example Domain' }))).toBe('Example Domain')
    expect(surfaceTitle(surface({ kind: 'browser', page_title: 'Example Domain', name: 'Docs' }))).toBe('Docs')
    expect(surfaceTitle(surface({ kind: 'terminal', name: 'Build' }))).toBe('Build')
  })
})
