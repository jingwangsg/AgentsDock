import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureSshConfigInclude, removeSshHost, resolvedSshOptions, sshDestination, sshHostFileContent, writeSshHost } from './ssh-hosts'

const RESOLVED = [
  'user root', 'hostname 10.244.141.135', 'port 22', 'addressfamily any', 'controlmaster auto',
  'identitiesonly yes', 'stricthostkeychecking false', 'serveraliveinterval 0', 'forwardagent yes',
  'identityfile ~/.sky/generated/ssh-keys/jing-debug-a236.key', 'identityfile ~/.ssh/id_ed25519',
  'globalknownhostsfile /dev/null', 'userknownhostsfile /dev/null', 'setenv SKY_CLUSTER_NAME=jing-debug-a236-8dfa2fda',
  'proxyjump none', "proxycommand ssh -tt -W '[%h]:%p' root@127.0.0.1", ''
].join('\n')

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const paths = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsdock-ssh-hosts-'))
  dirs.push(dir)
  return { hostsDir: join(dir, 'hosts'), sshConfig: join(dir, 'ssh', 'config') }
}

describe('sshDestination', () => {
  it('strips the hub notation for a Sky cluster and refuses an osmo workflow or an option', () => {
    expect(sshDestination('oci@jing-debug-a236')).toBe('jing-debug-a236')
    expect(sshDestination(' nv_gb300 ')).toBe('nv_gb300')
    expect(sshDestination('root@10.0.0.5:2222')).toBe('root@10.0.0.5:2222')
    expect(() => sshDestination('osmo@wf-1')).toThrow('osmo')
    expect(() => sshDestination('-oProxyCommand=evil')).toThrow('SSH host')
  })
})

describe('sshHostFileContent', () => {
  it('writes the SkyPilot-shaped block from the resolved options, yes/no for booleans, dropping unset ones', async () => {
    const run = vi.fn(async (args: string[]) => { expect(args).toEqual(['-G', 'jing-debug-a236']); return RESOLVED })
    const content = sshHostFileContent('oci_dev', 'oci@jing-debug-a236', await resolvedSshOptions('jing-debug-a236', run))
    expect(content.split('\n')).toEqual([
      '# Added by AgentsDock for the server "oci_dev" (SSH host oci@jing-debug-a236). Rewritten when that server is opened or changes; turning off Forward SSH removes it.',
      'Host oci_dev',
      '  HostName 10.244.141.135',
      '  User root',
      '  Port 22',
      '  IdentityFile ~/.sky/generated/ssh-keys/jing-debug-a236.key',
      '  IdentityFile ~/.ssh/id_ed25519',
      '  IdentitiesOnly yes',
      '  ForwardAgent yes',
      '  StrictHostKeyChecking no',
      '  UserKnownHostsFile /dev/null',
      '  GlobalKnownHostsFile /dev/null',
      '  SetEnv SKY_CLUSTER_NAME=jing-debug-a236-8dfa2fda',
      "  ProxyCommand ssh -tt -W '[%h]:%p' root@127.0.0.1",
      ''
    ])
  })

  it('refuses an alias that is not a plain host name', () => {
    expect(() => sshHostFileContent('my server', 'host', new Map())).toThrow('alias')
    expect(() => sshHostFileContent('-x', 'host', new Map())).toThrow('alias')
  })
})

describe('writeSshHost', () => {
  it('writes the alias file 0600 under the hosts directory, includes the directory first in the SSH config once, and removes on request', async () => {
    const p = paths()
    mkdirSync(join(p.sshConfig, '..'), { recursive: true })
    writeFileSync(p.sshConfig, 'Host existing\n  HostName 1.2.3.4\n', { mode: 0o600 })
    const run = async () => RESOLVED
    const file = await writeSshHost('oci_dev', 'oci@jing-debug-a236', p, run)
    expect(file).toBe(join(p.hostsDir, 'oci_dev'))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toContain('Host oci_dev\n  HostName 10.244.141.135')
    expect(readFileSync(p.sshConfig, 'utf8')).toBe(`Include ${p.hostsDir}/*\nHost existing\n  HostName 1.2.3.4\n`)
    await writeSshHost('oci_dev', 'oci@jing-debug-a236', p, run)
    ensureSshConfigInclude(p)
    expect(readFileSync(p.sshConfig, 'utf8').match(/^Include /gm)).toHaveLength(1)
    removeSshHost('oci_dev', p)
    expect(() => statSync(file)).toThrow()
    removeSshHost('oci_dev', p) // gone already: no error
  })

  it('creates a missing SSH config with only the include', async () => {
    const p = paths()
    await writeSshHost('nv_gb300', 'nv_gb300', p, async () => 'hostname gb300.internal\nuser jingwang\nport 22\n')
    expect(readFileSync(p.sshConfig, 'utf8')).toBe(`Include ${p.hostsDir}/*\n`)
    expect(statSync(p.sshConfig).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(p.hostsDir, 'nv_gb300'), 'utf8')).toContain('Host nv_gb300\n  HostName gb300.internal\n  User jingwang\n  Port 22\n')
  })
})
