import { describe, expect, it } from 'vitest'
import { findZedCli, zedTarget } from './open-in-zed'

describe('zedTarget', () => {
  it('passes a local absolute path through unchanged', () => {
    expect(zedTarget({ path: '/Users/me/proj' })).toBe('/Users/me/proj')
    expect(zedTarget({ path: ' /Users/me/proj ', sshHost: null })).toBe('/Users/me/proj')
  })

  it('builds an ssh:// URL for a remote server', () => {
    expect(zedTarget({ path: '/mnt/lustre/proj', sshHost: 'osmo_9000' })).toBe('ssh://osmo_9000/mnt/lustre/proj')
    expect(zedTarget({ path: '/srv', sshHost: 'root@10.0.0.5:2222' })).toBe('ssh://root@10.0.0.5:2222/srv')
  })

  it('percent-encodes path segments so Zed does not read `#` as a URL fragment', () => {
    expect(zedTarget({ path: '/home/u/exp#3', sshHost: 'osmo_9000' })).toBe('ssh://osmo_9000/home/u/exp%233')
  })

  it('rejects relative paths and option-like or malformed hosts', () => {
    expect(() => zedTarget({ path: 'proj' })).toThrow(/absolute path/)
    expect(() => zedTarget({ path: '/srv', sshHost: '-oProxyCommand=evil' })).toThrow(/SSH host/)
    expect(() => zedTarget({ path: '/srv', sshHost: 'host name' })).toThrow(/SSH host/)
  })
})

describe('findZedCli', () => {
  it('returns the first existing candidate or null', () => {
    expect(findZedCli(['/definitely/missing/zed', '/bin/sh'])).toBe('/bin/sh')
    expect(findZedCli(['/definitely/missing/zed'])).toBeNull()
  })
})
