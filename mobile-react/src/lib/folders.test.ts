import assert from 'node:assert/strict'
import test from 'node:test'
import { folderIn, folderIsHidden, folderIsWithin, folderLeaf, folderOrderAfterMove, folderParent, folderSegments, folderTree, movedFolder, reorderFolderList } from './folders'

test('reads a name as a path', () => {
  assert.deepEqual(folderSegments(' Work / Papers '), ['Work', 'Papers'])
  assert.deepEqual([folderParent('Work/Papers/2026'), folderParent('Work')], ['Work/Papers', null])
  assert.deepEqual([folderLeaf('Work/Papers'), folderLeaf('Work'), folderLeaf('/')], ['Papers', 'Work', '/'])
  assert.deepEqual([folderIn(null, 'Papers'), folderIn('Work', 'Papers'), folderIn('Work', 'Papers/2026')], ['Papers', 'Work/Papers', 'Work/Papers/2026'])
})

test('tells a folder inside another from one whose name only starts alike', () => {
  assert.equal(folderIsWithin('Work/Papers', 'Work'), true)
  assert.equal(folderIsWithin('Work', 'Work'), true)
  assert.equal(folderIsWithin('Workshop', 'Work'), false)
  assert.equal(folderIsWithin('Work', 'Work/Papers'), false)
})

test('hides a folder under a collapsed one, at any depth, but not the collapsed one itself', () => {
  assert.equal(folderIsHidden('Work/Papers/2026', ['Work']), true)
  assert.equal(folderIsHidden('Work', ['Work']), false)
  assert.equal(folderIsHidden('Workshop', ['Work']), false)
})

test('lists each folder before its subfolders and adds a parent only subfolders name', () => {
  assert.deepEqual(folderTree(['Ops', 'Work/Papers', 'General', 'Work', 'Lab/Runs/Old', 'Work/Code']), [
    'Ops', 'Work', 'Work/Papers', 'Work/Code', 'General', 'Lab', 'Lab/Runs', 'Lab/Runs/Old',
  ])
})

test('keeps a listed folder once when a name spells its path differently', () => {
  assert.deepEqual(folderTree(['Work / Papers', 'Work', 'Work/Papers/2026']), ['Work', 'Work / Papers', 'Work/Papers/2026'])
})

test('gives a moved folder and its subfolders their new paths', () => {
  assert.equal(movedFolder('Work/Papers/2026', 'Work/Papers', 'Archive/Papers'), 'Archive/Papers/2026')
  assert.equal(movedFolder('Work/Papers', 'Work/Papers', 'Reading'), 'Reading')
})

test('renames in place and moves a folder to the end of its new parent', () => {
  const folders = ['Work', 'Work/Papers', 'Work/Papers/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General']
  assert.deepEqual(folderOrderAfterMove(folders, 'Work/Papers', 'Work/Reading'), ['Work', 'Work/Reading', 'Work/Reading/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General'])
  assert.deepEqual(folderOrderAfterMove(folders, 'Work/Papers', 'Lab/Papers'), ['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'Lab/Papers', 'Lab/Papers/2026', 'General'])
  assert.deepEqual(folderOrderAfterMove(folders, 'Work/Papers', 'Papers'), ['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'General', 'Papers', 'Papers/2026'])
})

test('reorders a folder with its subfolders among the folders of its parent only', () => {
  const folders = ['Work', 'Work/Papers', 'Work/Papers/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General']
  assert.deepEqual(reorderFolderList(folders, 'Work', 'Lab', 'after'), ['Lab', 'Lab/Runs', 'Work', 'Work/Papers', 'Work/Papers/2026', 'Work/Code', 'General'])
  assert.deepEqual(reorderFolderList(folders, 'General', 'Work', 'before'), ['General', 'Work', 'Work/Papers', 'Work/Papers/2026', 'Work/Code', 'Lab', 'Lab/Runs'])
  assert.deepEqual(reorderFolderList(folders, 'Work/Code', 'Work/Papers', 'before'), ['Work', 'Work/Code', 'Work/Papers', 'Work/Papers/2026', 'Lab', 'Lab/Runs', 'General'])
  assert.deepEqual(reorderFolderList(folders, 'Work/Papers', 'Work/Code', 'after'), ['Work', 'Work/Code', 'Work/Papers', 'Work/Papers/2026', 'Lab', 'Lab/Runs', 'General'])
  // Across parents, onto itself, or with a folder the list does not have: the same array.
  assert.equal(reorderFolderList(folders, 'Work/Papers', 'Lab/Runs', 'before'), folders)
  assert.equal(reorderFolderList(folders, 'Work/Papers', 'Lab', 'after'), folders)
  assert.equal(reorderFolderList(folders, 'Work', 'Work', 'after'), folders)
  assert.equal(reorderFolderList(folders, 'Missing', 'Work', 'before'), folders)
})
