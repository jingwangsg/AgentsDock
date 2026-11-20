import assert from 'node:assert/strict'
import test from 'node:test'
import { folderIsWithin, folderOrderAfterRename, folderOwnName, folderParent, folderPath, folderPathIn, folderSegments, folderTree, renamedFolder, reorderFolderList } from './folders'

test('reads a name as a path, whatever the spaces and empty names in it', () => {
  assert.deepEqual(folderSegments(' Work / Papers '), ['Work', 'Papers'])
  assert.deepEqual([folderPath(' Work / Papers '), folderPath('Work//Papers/'), folderPath('Work')], ['Work/Papers', 'Work/Papers', 'Work'])
  assert.deepEqual([folderParent('Work/Papers/2026'), folderParent('Work')], ['Work/Papers', null])
  assert.deepEqual([folderOwnName('Work/Papers'), folderOwnName('Work')], ['Papers', 'Work'])
  assert.deepEqual([folderPathIn(null, 'Papers'), folderPathIn('Work', 'Papers'), folderPathIn('Work', 'Papers/2026')], ['Papers', 'Work/Papers', 'Work/Papers/2026'])
})

test('takes a name without an own name as it is, and no other folder is within it', () => {
  assert.deepEqual(folderOwnName('/'), '/')
  assert.deepEqual([folderIsWithin('/', '/'), folderIsWithin('Work', '/'), folderIsWithin('Work/Papers', ' / ')], [true, false, false])
})

test('tells a subfolder from a folder whose name only starts alike', () => {
  assert.deepEqual([folderIsWithin('Work/Papers', 'Work'), folderIsWithin('Work/Papers/2026', 'Work'), folderIsWithin('Work', 'Work')], [true, true, true])
  assert.deepEqual([folderIsWithin('Workshop', 'Work'), folderIsWithin('Work', 'Work/Papers')], [false, false])
})

test('lists every folder once, directly before its subfolders, and adds a parent missing from the list', () => {
  assert.deepEqual(folderTree(['Ops', 'Work/Papers', 'General', 'Work', 'Lab/Runs/Old', 'Work/Code', 'Ops']), ['Ops', 'Work', 'Work/Papers', 'Work/Code', 'General', 'Lab', 'Lab/Runs', 'Lab/Runs/Old'])
})

test('does not add a parent again when the list spells its path with spaces', () => {
  assert.deepEqual(folderTree(['Work / Papers', 'Work', 'Work/Papers/2026']), ['Work', 'Work / Papers', 'Work/Papers/2026'])
})

test('gives a renamed folder and its subfolders their new paths', () => {
  assert.deepEqual(renamedFolder('Work/Papers/2026', 'Work/Papers', 'Archive/Papers'), 'Archive/Papers/2026')
  assert.deepEqual(renamedFolder('Work/Papers', 'Work/Papers', 'Reading'), 'Reading')
})

test("keeps a folder's place when only its own name changes, and puts it last in a new parent or at the top level", () => {
  const folders = ['Work', 'Work/Papers', 'Work/Papers/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General']
  assert.deepEqual(folderOrderAfterRename(folders, 'Work/Papers', 'Work/Reading'), ['Work', 'Work/Reading', 'Work/Reading/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General'])
  assert.deepEqual(folderOrderAfterRename(folders, 'Work/Papers', 'Lab/Papers'), ['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'Lab/Papers', 'Lab/Papers/2026', 'General'])
  assert.deepEqual(folderOrderAfterRename(folders, 'Work/Papers', 'Papers'), ['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'General', 'Papers', 'Papers/2026'])
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
