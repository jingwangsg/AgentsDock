import { describe, expect, it } from 'vitest'
import { folderIn, folderIsHidden, folderIsWithin, folderLeaf, folderOrderAfterMove, folderParent, folderSegments, folderTree, movedFolder, rememberedFolderOrder, sidebarFolders } from './folders'
import type { Session } from './types'

describe('rememberedFolderOrder', () => {
  it('appends folders that only exist on sessions, keeping the persisted order first', () => {
    expect(rememberedFolderOrder(['Work'], [{ folder: 'Personal' }, { folder: 'Work' }, { folder: ' Ops ' }, { folder: null }])).toEqual(['Work', 'Personal', 'Ops'])
  })

  it('records General like any other folder and ignores blanks', () => {
    expect(rememberedFolderOrder([], [{ folder: 'General' }, { folder: '' }, { folder: undefined }])).toEqual(['General'])
  })

  it('keeps folders whose chats are all gone', () => {
    expect(rememberedFolderOrder(['Archive me'], [])).toEqual(['Archive me'])
  })
})

describe('nested folders', () => {
  it('reads a name as a path', () => {
    expect(folderSegments(' Work / Papers ')).toEqual(['Work', 'Papers'])
    expect([folderParent('Work/Papers/2026'), folderParent('Work')]).toEqual(['Work/Papers', null])
    expect([folderLeaf('Work/Papers'), folderLeaf('Work'), folderLeaf('/')]).toEqual(['Papers', 'Work', '/'])
    expect([folderIn(null, 'Papers'), folderIn('Work', 'Papers'), folderIn('Work', 'Papers/2026')]).toEqual(['Papers', 'Work/Papers', 'Work/Papers/2026'])
  })

  it('tells a folder inside another from one whose name only starts alike', () => {
    expect(folderIsWithin('Work/Papers', 'Work')).toBe(true)
    expect(folderIsWithin('Work', 'Work')).toBe(true)
    expect(folderIsWithin('Workshop', 'Work')).toBe(false)
    expect(folderIsWithin('Work', 'Work/Papers')).toBe(false)
  })

  it('hides a folder under a collapsed one, at any depth, but not the collapsed one itself', () => {
    expect(folderIsHidden('Work/Papers/2026', ['Work'])).toBe(true)
    expect(folderIsHidden('Work', ['Work'])).toBe(false)
    expect(folderIsHidden('Workshop', ['Work'])).toBe(false)
  })

  it('lists each folder before its subfolders and adds a parent only subfolders name', () => {
    expect(folderTree(['Ops', 'Work/Papers', 'General', 'Work', 'Lab/Runs/Old', 'Work/Code'])).toEqual([
      'Ops', 'Work', 'Work/Papers', 'Work/Code', 'General', 'Lab', 'Lab/Runs', 'Lab/Runs/Old'
    ])
  })

  it('keeps a listed folder once when a name spells its path differently', () => {
    expect(folderTree(['Work / Papers', 'Work', 'Work/Papers/2026'])).toEqual(['Work', 'Work / Papers', 'Work/Papers/2026'])
  })

  it('gives a moved folder and its subfolders their new paths', () => {
    expect(movedFolder('Work/Papers/2026', 'Work/Papers', 'Archive/Papers')).toBe('Archive/Papers/2026')
    expect(movedFolder('Work/Papers', 'Work/Papers', 'Reading')).toBe('Reading')
  })

  it('renames in place and moves a folder to the end of its new parent', () => {
    const folders = ['Work', 'Work/Papers', 'Work/Papers/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General']
    expect(folderOrderAfterMove(folders, 'Work/Papers', 'Work/Reading')).toEqual(['Work', 'Work/Reading', 'Work/Reading/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General'])
    expect(folderOrderAfterMove(folders, 'Work/Papers', 'Lab/Papers')).toEqual(['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'Lab/Papers', 'Lab/Papers/2026', 'General'])
    expect(folderOrderAfterMove(folders, 'Work/Papers', 'Papers')).toEqual(['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'General', 'Papers', 'Papers/2026'])
  })
})

describe('sidebarFolders', () => {
  const chat = (folder: string | null, extra: Partial<Session> = {}) => ({ folder, archived: false, pinned: false, ...extra }) as Session

  it('orders by the folder order, then by name, with subfolders under their parent', () => {
    expect(sidebarFolders([chat('Work/Papers'), chat(null), chat('Alpha'), chat('Old', { archived: true })], ['Work', 'Lab/Runs'])).toEqual([
      'Work', 'Work/Papers', 'Lab', 'Lab/Runs', 'Alpha', 'General'
    ])
  })
})
