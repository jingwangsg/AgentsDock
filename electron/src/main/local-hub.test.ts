import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PublicServerProfile, RemoteServer } from '../shared/types'
import { hubRemoteId, hubRemoteProfileOrder, hubRemotesKey, localHubConfigDirs, parseConfigEnv, planHubRemoteProfiles, readLocalHubToken } from './local-hub'

const HUB = 'http://127.0.0.1:7850'

function remote(id: string, overrides: Partial<RemoteServer> = {}): RemoteServer {
  return {
    id, name: id, ssh_host: `${id}_host`, install_dir: '~/.agentsdock-server', remote_port: 7850, local_port: 7851,
    created_at: '2026-01-01T00:00:00Z', proxy_path: `/api/remote/${id}`, tunnel: null, ...overrides
  }
}

function profile(id: string, serverUrl: string, sshHost: string | null = null, name = id): PublicServerProfile {
  return { id, name, serverUrl, hasAccessToken: true, serverSetupComplete: true, connectionState: 'cached', cachedUnreadCount: 0, sshHost }
}

describe('parseConfigEnv', () => {
  it('reads KEY=VALUE lines the way the server does', () => {
    expect(parseConfigEnv([
      '# comment', '', 'export AGENTSDOCK_AGENT_TOKEN="abc\\"def"', "AGENTSDOCK_STATE_DIR='/tmp/x y'",
      'PLAIN=value with spaces ', 'not a line', '1BAD=x', 'EMPTY='
    ].join('\n'))).toEqual({ AGENTSDOCK_AGENT_TOKEN: 'abc"def', AGENTSDOCK_STATE_DIR: '/tmp/x y', PLAIN: 'value with spaces', EMPTY: '' })
  })

  it('falls back to stripping quotes when a double-quoted value is not valid JSON', () => {
    expect(parseConfigEnv('A="tab\\qhere"')).toEqual({ A: 'tab\\qhere' })
  })
})

describe('readLocalHubToken', () => {
  const dirs: string[] = []
  const configDir = (env: string | null): string => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsdock-hub-'))
    dirs.push(dir)
    if (env !== null) writeFileSync(join(dir, 'env'), env)
    return dir
  }
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('returns the token from the env file', () => {
    const token = 'a'.repeat(64)
    expect(readLocalHubToken(configDir(`export AGENTSDOCK_AGENT_TOKEN=${token}\nAGENTSDOCK_AGENT_PORT=7850\n`))).toBe(token)
  })

  it('returns an empty string for a short or missing token or a missing file', () => {
    expect(readLocalHubToken(configDir('AGENTSDOCK_AGENT_TOKEN=short\n'))).toBe('')
    expect(readLocalHubToken(configDir('AGENTSDOCK_AGENT_PORT=7850\n'))).toBe('')
    expect(readLocalHubToken(configDir(null))).toBe('')
  })
})

describe('localHubConfigDirs', () => {
  const homes: string[] = []
  afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

  it('searches the default install, then named instances by name, then a hub-deployed server, then a source checkout', () => {
    const home = mkdtempSync(join(tmpdir(), 'agentsdock-home-'))
    homes.push(home)
    for (const name of ['zeta', 'alpha']) mkdirSync(join(home, '.config', 'agents-server-instances', name), { recursive: true })
    writeFileSync(join(home, '.config', 'agents-server-instances', '.DS_Store'), '')
    expect(localHubConfigDirs(home, undefined)).toEqual([
      join(home, '.config', 'agents-server'),
      join(home, '.config', 'agents-server-instances', 'alpha'),
      join(home, '.config', 'agents-server-instances', 'zeta'),
      join(home, '.agentsdock-server'),
      join(home, '.config', 'agentsdock-local')
    ])
  })

  it('uses only AGENTS_SERVER_CONFIG_DIR when it is set', () => {
    expect(localHubConfigDirs('/home/me', '/srv/agents-config')).toEqual(['/srv/agents-config'])
  })
})

describe('planHubRemoteProfiles', () => {
  it('adds registry entries that have no profile yet', () => {
    expect(planHubRemoteProfiles(HUB, [remote('abc123def456')], [profile('hub', HUB)])).toEqual({
      add: [{ name: 'abc123def456', serverUrl: `${HUB}/api/remote/abc123def456`, sshHost: 'abc123def456_host' }],
      update: [],
      remove: []
    })
  })

  it('removes proxied profiles the registry no longer lists and updates a drifted ssh host', () => {
    const plan = planHubRemoteProfiles(HUB, [remote('keep', { ssh_host: 'osmo_9000' })], [
      profile('hub', HUB),
      profile('p-keep', `${HUB}/api/remote/keep`, 'old_host', 'keep'),
      profile('p-stale', `${HUB}/api/remote/stale/`, 'stale_host'),
      profile('legacy', 'http://127.0.0.1:7851', 'osmo_9000'),
      profile('other-hub', 'http://10.0.0.5:7850/api/remote/zzz')
    ])
    expect(plan).toEqual({ add: [], update: [{ id: 'p-keep', name: 'keep', sshHost: 'osmo_9000', hidden: false }], remove: ['p-stale'] })
  })

  it('mirrors the hub\'s hidden flag on new and existing profiles', () => {
    const wasHidden = { ...profile('p-hidden', `${HUB}/api/remote/shown`, 'shown_host', 'shown'), hidden: true }
    const plan = planHubRemoteProfiles(HUB, [remote('shown'), remote('hide', { hidden: true }), remote('fresh', { hidden: true })], [
      profile('hub', HUB), wasHidden, profile('p-hide', `${HUB}/api/remote/hide`, 'hide_host', 'hide')
    ])
    expect(plan).toEqual({
      add: [{ name: 'fresh', serverUrl: `${HUB}/api/remote/fresh`, sshHost: 'fresh_host', hidden: true }],
      update: [{ id: 'p-hidden', name: 'shown', sshHost: 'shown_host', hidden: false }, { id: 'p-hide', name: 'hide', sshHost: 'hide_host', hidden: true }],
      remove: []
    })
  })

  it('takes the hub\'s name for a saved remote, even one another remote shares', () => {
    const plan = planHubRemoteProfiles(HUB, [remote('one', { name: 'oci_dev' }), remote('two', { name: 'oci_dev' })], [
      profile('hub', HUB), profile('p1', `${HUB}/api/remote/one`, 'one_host', 'oci_dev_32g'), profile('p2', `${HUB}/api/remote/two`, 'two_host', 'oci_dev')
    ])
    expect(plan).toEqual({ add: [], update: [{ id: 'p1', name: 'oci_dev', sshHost: 'one_host', hidden: false }], remove: [] })
  })

  it('is a no-op when profiles already mirror the registry', () => {
    const remotes = [remote('one'), remote('two')]
    const profiles = [profile('hub', HUB), profile('p1', `${HUB}/api/remote/one`, 'one_host', 'one'), profile('p2', `${HUB}/api/remote/two/`, 'two_host', 'two')]
    expect(planHubRemoteProfiles(`${HUB}/`, remotes, profiles)).toEqual({ add: [], update: [], remove: [] })
  })
})

describe('hubRemotesKey', () => {
  it('changes with the registry order, with which remotes are hidden and with their names, and reads a hub without them as none', () => {
    expect(hubRemotesKey(['one', 'two'])).toBe(hubRemotesKey(['one', 'two'], [], []))
    expect(new Set([
      hubRemotesKey(['one', 'two']), hubRemotesKey(['two', 'one']), hubRemotesKey(['one', 'two'], ['two']),
      hubRemotesKey(['one', 'two'], [], ['a b', 'c']), hubRemotesKey(['one', 'two'], [], ['a', 'b c'])
    ]).size).toBe(5)
  })
})

describe('hub remote order', () => {
  const profiles = [
    profile('hub', HUB),
    profile('p-one', `${HUB}/api/remote/one`),
    profile('legacy', 'http://127.0.0.1:7851'),
    profile('p-two', `${HUB}/api/remote/two/`),
    profile('other-hub', 'http://10.0.0.5:7850/api/remote/zzz')
  ]

  it('reads the registry id out of a proxied URL only', () => {
    expect(hubRemoteId(HUB, `${HUB}/api/remote/two/`)).toBe('two')
    expect(hubRemoteId(HUB, 'http://10.0.0.5:7850/api/remote/zzz')).toBeNull()
  })

  it('moves this hub\'s remotes into registry order within the places they hold', () => {
    expect(hubRemoteProfileOrder(HUB, [remote('two'), remote('one')], profiles)).toEqual(['hub', 'p-two', 'legacy', 'p-one', 'other-hub'])
    expect(hubRemoteProfileOrder(HUB, [remote('one'), remote('two')], profiles)).toBeNull()
  })
})
