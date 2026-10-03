import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Surface } from '../types'
import { browserAddressURL, promptSurfaceRename, surfaceSubline, surfaceTitle } from './surfaces'

const surface = (patch: Partial<Surface>): Surface => ({
  id: 'x', kind: 'terminal', name: null, folder: 'General', cwd: null, url: null, page_title: null, created_at: '', updated_at: '', ...patch,
})

test('surfaceTitle prefers the rename, then the page title, then the kind', () => {
  assert.equal(surfaceTitle(surface({ kind: 'terminal' })), 'Terminal')
  assert.equal(surfaceTitle(surface({ kind: 'browser' })), 'Browser')
  assert.equal(surfaceTitle(surface({ kind: 'browser', page_title: 'Example Domain' })), 'Example Domain')
  assert.equal(surfaceTitle(surface({ kind: 'browser', page_title: 'Example Domain', name: 'Docs' })), 'Docs')
  assert.equal(surfaceTitle(surface({ kind: 'terminal', name: 'Build' })), 'Build')
})

test('surfaceSubline shows the shell directory tail or the page host', () => {
  assert.equal(surfaceSubline(surface({ kind: 'terminal', cwd: '/Users/me/WORKSPACE/opencli' })), 'WORKSPACE / opencli')
  assert.equal(surfaceSubline(surface({ kind: 'terminal' })), 'Terminal')
  assert.equal(surfaceSubline(surface({ kind: 'browser', url: 'https://github.com/manaflow-ai/cmux' })), 'github.com')
  assert.equal(surfaceSubline(surface({ kind: 'browser', url: 'http://localhost:8000/x' })), 'localhost:8000')
  assert.equal(surfaceSubline(surface({ kind: 'browser' })), 'Browser')
})

test('promptSurfaceRename asks with the current title and turns the answer into a patch', async () => {
  let asked: unknown
  const answer = (value: string | null) => async (options: unknown) => { asked = options; return value }
  const browser = surface({ kind: 'browser', page_title: 'Example Domain' })
  assert.deepEqual(await promptSurfaceRename(browser, answer('Docs')), { name: 'Docs' })
  assert.deepEqual(asked, { title: 'Rename Tab', initialValue: 'Example Domain', confirmLabel: 'Rename', placeholder: 'Browser' })
  assert.equal(await promptSurfaceRename(browser, answer(null)), null, 'cancel sends nothing')
  const named = surface({ kind: 'terminal', name: 'Build' })
  assert.deepEqual(await promptSurfaceRename(named, answer('  ')), { name: null }, 'an emptied name returns to the default title')
  assert.equal(await promptSurfaceRename(named, answer('Build')), null, 'the same name sends nothing')
  assert.equal(await promptSurfaceRename(surface({ kind: 'terminal' }), answer('')), null, 'emptying an unnamed tab sends nothing')
})

test('browserAddressURL keeps web URLs, adds a scheme to hosts, searches words, refuses other schemes', () => {
  assert.equal(browserAddressURL(' https://example.com/a?b=1 '), 'https://example.com/a?b=1')
  assert.equal(browserAddressURL('docs.python.org/3/'), 'https://docs.python.org/3/')
  assert.equal(browserAddressURL('localhost:8000'), 'http://localhost:8000')
  assert.equal(browserAddressURL('ghostty terminal'), 'https://duckduckgo.com/?q=ghostty%20terminal')
  assert.equal(browserAddressURL('javascript:alert(1)'), null)
  assert.equal(browserAddressURL('   '), null)
})
