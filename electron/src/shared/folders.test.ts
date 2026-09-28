import { describe, expect, it } from 'vitest'
import { rememberedFolderOrder } from './folders'

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
