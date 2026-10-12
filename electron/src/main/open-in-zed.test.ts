// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { findZedCli, readZedWorkspaceFolders, zedTarget } from './open-in-zed'

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), execFile: vi.fn() }))

describe('zedTarget', () => {
  it('passes a local absolute path through unchanged', () => {
    expect(zedTarget({ path: '/Users/me/proj' })).toBe('/Users/me/proj')
    expect(zedTarget({ path: ' /Users/me/proj ', sshHost: null })).toBe('/Users/me/proj')
  })

  it('builds an ssh:// URL for a remote server', () => {
    expect(zedTarget({ path: '/mnt/lustre/proj', sshHost: 'osmo_9000' })).toBe('ssh://osmo_9000/mnt/lustre/proj')
    expect(zedTarget({ path: '/srv', sshHost: 'root@10.0.0.5:2222' })).toBe('ssh://root@10.0.0.5:2222/srv')
  })

  it('opens an oci@ cluster through its Sky alias and refuses an osmo@ workflow', () => {
    expect(zedTarget({ path: '/mnt/shared/u', sshHost: 'oci@sky-cluster' })).toBe('ssh://sky-cluster/mnt/shared/u')
    expect(() => zedTarget({ path: '/root', sshHost: 'osmo@wf-1' })).toThrow('osmo@')
  })

  it('names the local alias this Mac keeps for the server when Forward SSH is on', () => {
    expect(zedTarget({ path: '/mnt/lustre/proj', sshHost: 'oci@jing-debug-a236', hostAlias: 'oci_dev' })).toBe('ssh://oci_dev/mnt/lustre/proj')
    expect(zedTarget({ path: '/mnt/lustre/proj', sshHost: 'oci@jing-debug-a236', hostAlias: '' })).toBe('ssh://jing-debug-a236/mnt/lustre/proj')
    expect(() => zedTarget({ path: '/srv', sshHost: 'nv_gb300', hostAlias: 'my server' })).toThrow(/alias/)
  })

  it('percent-encodes path segments so Zed does not read `#` as a URL fragment', () => {
    expect(zedTarget({ path: '/home/u/exp#3', sshHost: 'osmo_9000' })).toBe('ssh://osmo_9000/home/u/exp%233')
  })

  it('appends a code reference line and column after the encoded path', () => {
    expect(zedTarget({ path: '/Users/me/proj/src/app.ts', line: 12 })).toBe('/Users/me/proj/src/app.ts:12')
    expect(zedTarget({ path: '/Users/me/proj/src/app.ts', line: 12, column: 7 })).toBe('/Users/me/proj/src/app.ts:12:7')
    expect(zedTarget({ path: '/home/u/exp#3/a b%.py', sshHost: 'osmo_9000', line: 4, column: 2 })).toBe('ssh://osmo_9000/home/u/exp%233/a%20b%25.py:4:2')
    // A column without a line is not a location Zed reads.
    expect(zedTarget({ path: '/srv/app.py', column: 3 })).toBe('/srv/app.py')
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

describe('readZedWorkspaceFolders', () => {
  // The part of Zed's state database the lookup reads.
  function zedDatabase(): { path: string; remove: () => void } {
    const directory = mkdtempSync(join(tmpdir(), 'zed-db-'))
    const path = join(directory, 'db.sqlite')
    const database = new DatabaseSync(path)
    database.exec(`
      create table kv_store (key text primary key, value text);
      create table remote_connections (id integer primary key, kind text, host text, port integer, user text);
      create table workspaces (workspace_id integer primary key, paths text, remote_connection_id integer, session_id text);
      insert into kv_store values ('session_id', 'now');
      insert into remote_connections values (1, 'ssh', 'cluster_alias', null, null), (2, 'ssh', '10.0.0.5', 2222, 'root'), (3, 'docker', null, null, null);
      insert into workspaces values
        (1, '/Users/me/proj' || char(10) || '/Users/me/notes', null, 'now'),
        (2, '/Users/me/closed', null, null),
        (3, '/Users/me/last-run', null, 'before'),
        (4, '/mnt/lustre/proj', 1, 'now'),
        (5, '/srv', 2, 'now'),
        (6, '/workspaces/app', 3, 'now');
    `)
    database.close()
    return { path, remove: () => rmSync(directory, { recursive: true, force: true }) }
  }
  const zedRunning = (running: boolean) => vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], callback: (error: Error | null) => void) => {
    callback(running ? null : new Error('no process'))
  }) as unknown as typeof execFile)

  it('lists the folders Zed has open now on the machine a chat runs on', async () => {
    const database = zedDatabase()
    try {
      zedRunning(true)
      expect(await readZedWorkspaceFolders({}, database.path)).toEqual(['/Users/me/proj', '/Users/me/notes'])
      expect(await readZedWorkspaceFolders({ sshHost: 'oci@pod-a', hostAlias: 'cluster_alias' }, database.path)).toEqual(['/mnt/lustre/proj'])
      expect(await readZedWorkspaceFolders({ sshHost: 'root@10.0.0.5:2222' }, database.path)).toEqual(['/srv'])
      expect(await readZedWorkspaceFolders({ sshHost: 'other_host' }, database.path)).toEqual([])
      expect(vi.mocked(execFile)).toHaveBeenLastCalledWith('pgrep', ['-f', '/Zed\\.app/Contents/MacOS/zed'], expect.any(Function))
    } finally {
      database.remove()
    }
  })

  it('finds none when Zed is not running or its database cannot be read', async () => {
    const database = zedDatabase()
    try {
      // The last session's workspaces stay marked after Zed quits, so they reopen on its next start.
      zedRunning(false)
      expect(await readZedWorkspaceFolders({}, database.path)).toEqual([])
      zedRunning(true)
      expect(await readZedWorkspaceFolders({}, join(tmpdir(), 'missing-zed-db', 'db.sqlite'))).toEqual([])
    } finally {
      database.remove()
    }
  })
})
