import assert from 'node:assert/strict'
import test from 'node:test'
import type { Session } from '../types'
import { orderedSessionSections, rememberedFolderOrder } from './session-order'

function session(id: string, folder = 'General'): Session {
  return { id, title: id, folder, backend: 'codex' } as Session
}

test('explicitly created custom folders remain visible before they contain chats', () => {
  assert.deepEqual(
    orderedSessionSections([session('general')], ['Empty folder'], true, true).map(section => [section.id, section.sessions.length]),
    [['Empty folder', 0], ['General', 1]],
  )
})

test('reserved empty sections stay hidden', () => {
  assert.deepEqual(
    orderedSessionSections([session('work', 'Work')], []).map(section => section.id),
    ['Work'],
  )
})

test('empty folders stay out of filtered results', () => {
  assert.deepEqual(
    orderedSessionSections([], ['Empty folder']).map(section => section.id),
    [],
  )
})

test('the unfiltered sidebar keeps General listed when it holds no visible chat', () => {
  assert.deepEqual(
    orderedSessionSections([{ ...session('a', 'Work'), archived: true }], ['Work'], true, true).map(section => section.id),
    ['Work', 'General', 'Archived'],
  )
})

test('remembered folder order keeps folders that only exist on sessions', () => {
  assert.deepEqual(rememberedFolderOrder(['Work'], [session('x', 'Personal'), session('y', 'Work'), session('z')]), ['Work', 'Personal'])
  const same = ['Work']
  assert.equal(rememberedFolderOrder(same, [session('y', 'Work')]), same)
})
