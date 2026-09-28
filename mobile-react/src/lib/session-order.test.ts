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

test('a folder in folderOrder is kept in the unfiltered sidebar when it holds no visible chat', () => {
  assert.deepEqual(
    orderedSessionSections([{ ...session('a', 'Work'), archived: true }], ['Work'], true, true).map(section => section.id),
    ['Work', 'Archived'],
  )
})

test('General takes its folderOrder position like any other folder', () => {
  assert.deepEqual(
    orderedSessionSections([session('g'), session('w', 'Work'), session('p', 'Personal')], ['Work', 'General', 'Personal']).map(section => section.id),
    ['Work', 'General', 'Personal'],
  )
})

test('General is hidden when it is empty and not in folderOrder', () => {
  assert.deepEqual(
    orderedSessionSections([session('w', 'Work'), { ...session('p', 'Work'), pinned: true }], ['Work'], true, true).map(section => section.id),
    ['Pinned', 'Work'],
  )
})

test('folders missing from folderOrder follow it in first-seen order', () => {
  assert.deepEqual(
    orderedSessionSections([session('z', 'Zeta'), session('g'), session('a', 'Alpha')], ['Work'], true, true).map(section => section.id),
    ['Work', 'Zeta', 'General', 'Alpha'],
  )
})

test('remembered folder order keeps folders that only exist on sessions, General included', () => {
  assert.deepEqual(rememberedFolderOrder(['Work'], [session('x', 'Personal'), session('y', 'Work'), session('z')]), ['Work', 'Personal', 'General'])
  assert.deepEqual(rememberedFolderOrder([], [session('z')]), ['General'])
  const same = ['Work']
  assert.equal(rememberedFolderOrder(same, [session('y', 'Work')]), same)
})
