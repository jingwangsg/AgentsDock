import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InferenceProxyManager, type CommandResult } from './inference-proxy'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() } }))

const UPSTREAM = 'https://inference-api.nvidia.com/v1/'
// The LaunchAgent label is a wire name shared with the proxy's installer; pinned literally.
const LABEL = 'com.agentsdock.inference-proxy'
const TARGET = `gui/501/${LABEL}`

describe('InferenceProxyManager', () => {
  let root: string
  let calls: string[][]
  let launchdRunning: boolean
  let launchdPid: number
  let healthy: boolean
  const copy = vi.fn()
  const run = vi.fn<(file: string, args: string[]) => Promise<CommandResult>>()
  // launchd as the module sees it: `print` reports the running pid, `kickstart -k` replaces the instance.
  const defaultRun = async (file: string, args: string[]): Promise<CommandResult> => {
    calls.push([file, ...args])
    if (args[0] === 'print') return launchdRunning ? { ok: true, output: `\tstate = running\n\tpid = ${launchdPid}` } : { ok: false, output: 'Could not find service' }
    if (args[0] === 'kickstart' && args[1] === '-k') launchdPid += 1
    if (args[0] === 'bootout') launchdRunning = false
    return { ok: true, output: '' }
  }
  const paths = () => ({
    configFile: join(root, 'config', 'config.json'),
    plistFile: join(root, 'LaunchAgents', `${LABEL}.plist`),
    hubEnvFile: join(root, 'agents-server', 'env')
  })
  const manager = () => new InferenceProxyManager({ paths: paths(), run, probeHealth: async () => healthy, copyText: copy, uid: 501, startTimeoutMs: 50 })
  const installPlist = () => { mkdirSync(join(root, 'LaunchAgents'), { recursive: true }); writeFileSync(paths().plistFile, '<plist/>') }
  const writeHubEnv = (text: string) => { mkdirSync(join(root, 'agents-server'), { recursive: true }); writeFileSync(paths().hubEnvFile, text) }
  const config = () => JSON.parse(readFileSync(paths().configFile, 'utf8'))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'inference-proxy-test-'))
    calls = []
    launchdRunning = false
    launchdPid = 42
    healthy = false
    copy.mockClear()
    run.mockReset()
    run.mockImplementation(defaultRun)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('reports defaults without creating files, then creates a private config on the first key', async () => {
    const status = await manager().status()
    expect(status).toMatchObject({ port: 20001, baseUrl: 'http://127.0.0.1:20001/v1', upstreamBaseUrl: UPSTREAM, hasProxyToken: false, keys: [], service: 'not-installed', healthy: false, localHubInstalled: false, hubForwardPort: null })
    expect(existsSync(paths().configFile)).toBe(false)

    const next = await manager().addKey(' yam-00 ', 'nvapi-0123456789abcd')
    expect(next.keys).toEqual([{ name: 'yam-00', enabled: true, hint: 'abcd' }])
    expect(next.hasProxyToken).toBe(true)
    expect(JSON.stringify(next)).not.toContain('nvapi-')
    expect(config()).toMatchObject({ upstream_base_url: UPSTREAM, host: '127.0.0.1', port: 20001, keys: [{ name: 'yam-00', api_key: 'nvapi-0123456789abcd', enabled: true, assigned_to: '' }] })
    expect(config().proxy_token).toHaveLength(43)
    expect(statSync(paths().configFile).mode & 0o777).toBe(0o600)
    expect(statSync(join(root, 'config')).mode & 0o777).toBe(0o700)
    await expect(manager().addKey('', 'k')).rejects.toThrow('Name is required.')
    await expect(manager().addKey('b', ' ')).rejects.toThrow('API key is required.')
  })

  it('preserves the proxy’s own fields when changing the port and points the local hub at it', async () => {
    const existing = { upstream_base_url: UPSTREAM, host: '0.0.0.0', port: 8788, proxy_token: 't'.repeat(43), max_inflight: 64, state_path: '/state.json', keys: [{ name: 'a', api_key: 'k-1234', enabled: false, assigned_to: 'x' }] }
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(paths().configFile, JSON.stringify(existing))
    writeHubEnv('export AGENTSDOCK_AGENT_TOKEN=secret\nexport PATH=/usr/bin')

    const status = await manager().setPort(20001)
    expect(status).toMatchObject({ port: 20001, baseUrl: 'http://127.0.0.1:20001/v1', localHubInstalled: true, hubForwardPort: 20001, keys: [{ name: 'a', enabled: false, hint: '1234' }] })
    expect(config()).toEqual({ ...existing, port: 20001 })
    const env = readFileSync(paths().hubEnvFile, 'utf8')
    expect(env.startsWith('export AGENTSDOCK_AGENT_TOKEN=secret\nexport PATH=/usr/bin\n')).toBe(true)
    expect(env.endsWith('\nexport AGENTSDOCK_INFERENCE_PROXY_PORT=20001\n')).toBe(true)

    await manager().setPort(20002)
    const again = readFileSync(paths().hubEnvFile, 'utf8')
    expect(again.match(/AGENTSDOCK_INFERENCE_PROXY_PORT/g)).toHaveLength(1)
    expect(again).toContain('\nexport AGENTSDOCK_INFERENCE_PROXY_PORT=20002\n')
    expect((await manager().status()).hubForwardPort).toBe(20002)
    await expect(manager().setPort(80)).rejects.toThrow('between 1024 and 65535')
  })

  it('leaves a machine without a local hub env file alone', async () => {
    const status = await manager().setPort(20001)
    expect(config().port).toBe(20001)
    expect(existsSync(paths().hubEnvFile)).toBe(false)
    expect(status).toMatchObject({ localHubInstalled: false, hubForwardPort: null })
  })

  it('restarts a running proxy after each config change and controls the LaunchAgent', async () => {
    installPlist()
    launchdRunning = true
    healthy = true
    const proxy = manager()
    await proxy.addKey('a', 'k-0001')
    await proxy.setKeyEnabled('a', false)
    expect(config().keys[0].enabled).toBe(false)
    await expect(proxy.setKeyEnabled('zzz', true)).rejects.toThrow('No key named zzz.')
    await expect(proxy.addKey('a', 'k-0002')).rejects.toThrow('A key named a already exists.')
    await proxy.removeKey('a')
    expect(config().keys).toEqual([])
    // Three saved changes, three restarts; the two rejected calls above saved nothing and restarted nothing.
    expect(calls.filter(call => call[1] === 'kickstart')).toEqual(Array(3).fill(['/bin/launchctl', 'kickstart', '-k', TARGET]))
    expect(await proxy.status()).toMatchObject({ service: 'running', healthy: true })

    calls = []
    const stopped = await proxy.stop()
    expect(calls).toEqual([['/bin/launchctl', 'bootout', TARGET], ['/bin/launchctl', 'print', TARGET]])
    // healthy stays false for a stopped service even though the probe would answer.
    expect(stopped).toMatchObject({ service: 'stopped', healthy: false })
  })

  it('does not probe /healthz after a restart until launchd reports a new pid', async () => {
    installPlist()
    launchdRunning = true
    const order: string[] = []
    let printsAfterRestart = 0
    run.mockImplementation(async (file, args) => {
      order.push(args.join(' '))
      // The old instance lingers for one poll: the first print after kickstart -k still shows pid 42.
      if (args[0] === 'print') return { ok: true, output: `state = running\npid = ${printsAfterRestart === 1 ? 42 : launchdPid}` }
      if (args[0] === 'kickstart' && args[1] === '-k') { launchdPid = 43; printsAfterRestart = 0 }
      return { ok: true, output: '' }
    })
    run.mockImplementation(async (file, args) => {
      order.push(args.join(' '))
      if (args[0] === 'print') { if (launchdPid === 43) printsAfterRestart += 1; return { ok: true, output: `state = running\npid = ${launchdPid === 43 && printsAfterRestart === 1 ? 42 : launchdPid}` } }
      if (args[0] === 'kickstart' && args[1] === '-k') launchdPid = 43
      return { ok: true, output: '' }
    })
    const proxy = new InferenceProxyManager({ paths: paths(), run, probeHealth: async () => { order.push('probe'); return true }, copyText: copy, uid: 501, startTimeoutMs: 2_000 })
    await proxy.addKey('a', 'k-0001')
    const restart = order.indexOf(`kickstart -k ${TARGET}`)
    expect(restart).toBeGreaterThan(0)
    // Two launchd polls (old pid, then the new one) before the first health probe.
    expect(order.slice(restart + 1, restart + 4)).toEqual([`print ${TARGET}`, `print ${TARGET}`, 'probe'])
  })

  it('re-saving the current port points the local hub at it without rewriting or restarting the proxy', async () => {
    installPlist()
    launchdRunning = true
    healthy = true
    const existing = JSON.stringify({ port: 20001, proxy_token: 't'.repeat(43), keys: [] })
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(paths().configFile, existing)
    writeHubEnv('export AGENTSDOCK_AGENT_TOKEN=secret\n')

    const status = await manager().setPort(20001)
    expect(calls.map(call => call[1])).not.toContain('kickstart')
    expect(readFileSync(paths().configFile, 'utf8')).toBe(existing)
    expect(status).toMatchObject({ port: 20001, hubForwardPort: 20001, service: 'running', healthy: true })
  })

  it('bootstraps the LaunchAgent when kickstart cannot find it, then waits for /healthz', async () => {
    installPlist()
    healthy = true
    run.mockImplementation(async (file, args) => {
      calls.push([file, ...args])
      if (args[0] === 'kickstart' && calls.filter(call => call[1] === 'kickstart').length === 1) return { ok: false, output: 'Could not find service' }
      if (args[0] === 'print') return { ok: true, output: 'state = running' }
      return { ok: true, output: '' }
    })
    const status = await manager().start()
    expect(calls.slice(0, 3)).toEqual([
      ['/bin/launchctl', 'kickstart', TARGET],
      ['/bin/launchctl', 'bootstrap', 'gui/501', paths().plistFile],
      ['/bin/launchctl', 'kickstart', TARGET]
    ])
    expect(status).toMatchObject({ service: 'running', healthy: true })
  })

  it('fails loudly when the service is not installed or never answers', async () => {
    await expect(manager().start()).rejects.toThrow(`No LaunchAgent at ${paths().plistFile}`)
    installPlist()
    await expect(manager().start()).rejects.toThrow('nothing answered on 127.0.0.1:20001/healthz')
    run.mockResolvedValue({ ok: false, output: 'Boot-out failed: 5: Input/output error' })
    await expect(manager().stop()).rejects.toThrow('Boot-out failed')
  })

  it('fails loudly when a running proxy does not restart after a config change, keeping the saved config', async () => {
    installPlist()
    launchdRunning = true
    run.mockImplementation(async (file, args) => args[0] === 'kickstart' ? { ok: false, output: 'Could not kickstart service' } : defaultRun(file, args))
    await expect(manager().addKey('a', 'k-0001')).rejects.toThrow('could not restart com.agentsdock.inference-proxy: Could not kickstart service')
    expect(config().keys).toEqual([{ name: 'a', api_key: 'k-0001', enabled: true, assigned_to: '' }])
  })

  it('copies the proxy token only inside the main process', async () => {
    expect(manager().copyProxyToken()).toBe(false)
    await manager().addKey('a', 'k-0001')
    expect(manager().copyProxyToken()).toBe(true)
    expect(copy).toHaveBeenCalledExactlyOnceWith(config().proxy_token)
  })
})
