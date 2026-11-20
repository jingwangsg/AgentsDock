import { describe, expect, it } from 'vitest'
import { folderIsWithin, folderOrderAfterRename, folderOwnName, folderParent, folderPath, folderPathIn, folderSegments, folderTree, rememberedFolderOrder, renamedFolder, sidebarFolders } from './folders'
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
  it('reads a name as a path, whatever the spaces and empty names in it', () => {
    expect(folderSegments(' Work / Papers ')).toEqual(['Work', 'Papers'])
    expect([folderPath(' Work / Papers '), folderPath('Work//Papers/'), folderPath('Work')]).toEqual(['Work/Papers', 'Work/Papers', 'Work'])
    expect([folderParent('Work/Papers/2026'), folderParent('Work')]).toEqual(['Work/Papers', null])
    expect([folderOwnName('Work/Papers'), folderOwnName('Work')]).toEqual(['Papers', 'Work'])
    expect([folderPathIn(null, 'Papers'), folderPathIn('Work', 'Papers'), folderPathIn('Work', 'Papers/2026')]).toEqual(['Papers', 'Work/Papers', 'Work/Papers/2026'])
  })

  it('takes a name without an own name as it is, and no other folder is within it', () => {
    expect(folderOwnName('/')).toEqual('/')
    expect([folderIsWithin('/', '/'), folderIsWithin('Work', '/'), folderIsWithin('Work/Papers', ' / ')]).toEqual([true, false, false])
  })

  it('tells a subfolder from a folder whose name only starts alike', () => {
    expect([folderIsWithin('Work/Papers', 'Work'), folderIsWithin('Work/Papers/2026', 'Work'), folderIsWithin('Work', 'Work')]).toEqual([true, true, true])
    expect([folderIsWithin('Workshop', 'Work'), folderIsWithin('Work', 'Work/Papers')]).toEqual([false, false])
  })

  it('lists every folder once, directly before its subfolders, and adds a parent missing from the list', () => {
    expect(folderTree(['Ops', 'Work/Papers', 'General', 'Work', 'Lab/Runs/Old', 'Work/Code', 'Ops'])).toEqual(['Ops', 'Work', 'Work/Papers', 'Work/Code', 'General', 'Lab', 'Lab/Runs', 'Lab/Runs/Old'])
  })

  it('does not add a parent again when the list spells its path with spaces', () => {
    expect(folderTree(['Work / Papers', 'Work', 'Work/Papers/2026'])).toEqual(['Work', 'Work / Papers', 'Work/Papers/2026'])
  })

  it('gives a renamed folder and its subfolders their new paths', () => {
    expect(renamedFolder('Work/Papers/2026', 'Work/Papers', 'Archive/Papers')).toEqual('Archive/Papers/2026')
    expect(renamedFolder('Work/Papers', 'Work/Papers', 'Reading')).toEqual('Reading')
  })

  it("keeps a folder's place when only its own name changes, and puts it last in a new parent or at the top level", () => {
    const folders = ['Work', 'Work/Papers', 'Work/Papers/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General']
    expect(folderOrderAfterRename(folders, 'Work/Papers', 'Work/Reading')).toEqual(['Work', 'Work/Reading', 'Work/Reading/2026', 'Work/Code', 'Lab', 'Lab/Runs', 'General'])
    expect(folderOrderAfterRename(folders, 'Work/Papers', 'Lab/Papers')).toEqual(['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'Lab/Papers', 'Lab/Papers/2026', 'General'])
    expect(folderOrderAfterRename(folders, 'Work/Papers', 'Papers')).toEqual(['Work', 'Work/Code', 'Lab', 'Lab/Runs', 'General', 'Papers', 'Papers/2026'])
  })
})

describe('sidebarFolders', () => {
  const chat = (folder: string | null, extra: Partial<Session> = {}) => ({ folder, archived: false, pinned: false, ...extra }) as Session

  it('orders by the folder order, then by name, each folder directly before its subfolders', () => {
    expect(sidebarFolders([chat('Work/Papers'), chat(null), chat('Alpha'), chat('Old', { archived: true })], ['Work', 'Lab/Runs'])).toEqual([
      'Work', 'Work/Papers', 'Lab', 'Lab/Runs', 'Alpha', 'General'
    ])
  })
})
