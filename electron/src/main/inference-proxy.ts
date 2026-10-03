import { clipboard } from 'electron'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { InferenceProxyStatus } from '../shared/types'
import { parseConfigEnv } from './local-hub'

/**
 * The NV Inference Hub proxy is the standalone `yam-api-proxy` service on this machine. It holds
 * the upstream API keys and answers OpenAI-style requests on 127.0.0.1:<port> for a per-machine
 * proxy token, so no chat ever needs the keys. This module owns what the desktop can change about
 * it: its config file, its LaunchAgent, and the local hub's env line that reverse-forwards the port
 * to every remote server (server/remote_servers.py, AGENTSDOCK_INFERENCE_PROXY_PORT).
 */
const INFERENCE_PROXY_LABEL = 'com.agentsdock.inference-proxy'
const INFERENCE_PROXY_DEFAULT_PORT = 20001
const INFERENCE_PROXY_UPSTREAM = 'https://inference-api.nvidia.com/v1/'
const INFERENCE_PROXY_PORT_ENV = 'AGENTSDOCK_INFERENCE_PROXY_PORT'
const HEALTH_TIMEOUT_MS = 2_000
const START_TIMEOUT_MS = 10_000

export interface InferenceProxyPaths {
  /** The proxy's own config file; its layout belongs to the proxy project (yam-api-proxy README). */
  configFile: string
  plistFile: string
  /** The local hub's env file, which its LaunchAgent reads at server start. */
  hubEnvFile: string
}

interface ProxyConfigKey { name: string; api_key: string; enabled: boolean; assigned_to?: string }
/** Only the fields the desktop reads or writes; everything else in the file is preserved as is. */
interface ProxyConfig {
  upstream_base_url: string
  host: string
  port: number
  proxy_token: string
  keys: ProxyConfigKey[]
  [other: string]: unknown
}

export interface CommandResult { ok: boolean; output: string }
export type RunCommand = (file: string, args: string[]) => Promise<CommandResult>

/** Every option is a test seam; ipc.ts constructs the manager with none. */
export interface InferenceProxyManagerOptions {
  paths?: InferenceProxyPaths
  run?: RunCommand
  probeHealth?: (port: number) => Promise<boolean>
  copyText?: (text: string) => void
  uid?: number
  startTimeoutMs?: number
}

export class InferenceProxyManager {
  private readonly paths: InferenceProxyPaths
  private readonly run: RunCommand
  private readonly probeHealth: (port: number) => Promise<boolean>
  private readonly copyText: (text: string) => void
  private readonly domain: string
  private readonly startTimeoutMs: number

  constructor(options: InferenceProxyManagerOptions = {}) {
    const home = homedir()
    this.paths = options.paths ?? {
      configFile: join(home, '.config', 'yam-api-proxy', 'config.json'),
      plistFile: join(home, 'Library', 'LaunchAgents', `${INFERENCE_PROXY_LABEL}.plist`),
      hubEnvFile: join(process.env.AGENTS_SERVER_CONFIG_DIR || join(home, '.config', 'agents-server'), 'env')
    }
    this.run = options.run ?? runCommand
    this.probeHealth = options.probeHealth ?? probeHealth
    this.copyText = options.copyText ?? (text => clipboard.writeText(text))
    this.domain = `gui/${options.uid ?? process.getuid?.() ?? 0}`
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS
  }

  async status(): Promise<InferenceProxyStatus> {
    const config = this.readConfig()
    const { service } = await this.launchdState()
    const hubEnv = this.readHubEnv()
    const forwardPort = Number(parseConfigEnv(hubEnv ?? '')[INFERENCE_PROXY_PORT_ENV])
    return {
      port: config.port,
      upstreamBaseUrl: config.upstream_base_url,
      baseUrl: `http://127.0.0.1:${config.port}/v1`,
      hasProxyToken: Boolean(config.proxy_token),
      keys: config.keys.map(key => ({ name: key.name, enabled: key.enabled !== false, hint: key.api_key.slice(-4) })),
      service,
      healthy: service === 'running' && await this.probeHealth(config.port),
      localHubInstalled: hubEnv !== null,
      hubForwardPort: Number.isInteger(forwardPort) && forwardPort > 0 ? forwardPort : null,
      configFile: this.paths.configFile,
      plistFile: this.paths.plistFile
    }
  }

  /** Also points the local hub at the port; the hub re-reads its env file only when it restarts. */
  async setPort(port: number): Promise<InferenceProxyStatus> {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535.')
    await this.mutate(config => { config.port = port })
    this.writeHubForwardPort(port)
    return this.status()
  }

  async addKey(name: string, apiKey: string): Promise<InferenceProxyStatus> {
    const keyName = name.trim()
    const key = apiKey.trim()
    if (!keyName) throw new Error('Name is required.')
    if (!key) throw new Error('API key is required.')
    await this.mutate(config => {
      if (config.keys.some(entry => entry.name === keyName)) throw new Error(`A key named ${keyName} already exists.`)
      config.keys.push({ name: keyName, api_key: key, enabled: true, assigned_to: '' })
    })
    return this.status()
  }

  async removeKey(name: string): Promise<InferenceProxyStatus> {
    await this.mutate(config => { config.keys.splice(indexOfKey(config, name), 1) })
    return this.status()
  }

  async setKeyEnabled(name: string, enabled: boolean): Promise<InferenceProxyStatus> {
    await this.mutate(config => { config.keys[indexOfKey(config, name)].enabled = enabled })
    return this.status()
  }

  async start(): Promise<InferenceProxyStatus> {
    if (!existsSync(this.paths.plistFile)) throw new Error(`No LaunchAgent at ${this.paths.plistFile}. Install the inference proxy service first.`)
    const target = `${this.domain}/${INFERENCE_PROXY_LABEL}`
    // Same kickstart, bootstrap, kickstart sequence as startLocalServerAgent in local-hub.ts; kept apart
    // because this one is injectable for tests and waits on /healthz rather than a TCP connect.
    // Without -k, kickstart leaves a running proxy alone; it fails when launchd has not loaded the plist.
    let result = await this.run('/bin/launchctl', ['kickstart', target])
    if (!result.ok) {
      result = await this.run('/bin/launchctl', ['bootstrap', this.domain, this.paths.plistFile])
      if (result.ok) result = await this.run('/bin/launchctl', ['kickstart', target])
    }
    if (!result.ok) throw new Error(`launchd could not start ${INFERENCE_PROXY_LABEL}: ${result.output}`)
    const port = this.readConfig().port
    if (!await this.waitUntil(() => this.probeHealth(port))) {
      throw new Error(`launchd started ${INFERENCE_PROXY_LABEL}, but nothing answered on 127.0.0.1:${port}/healthz within ${this.startTimeoutMs / 1000} s. Check the service's log.`)
    }
    return this.status()
  }

  async stop(): Promise<InferenceProxyStatus> {
    const result = await this.run('/bin/launchctl', ['bootout', `${this.domain}/${INFERENCE_PROXY_LABEL}`])
    if (!result.ok) throw new Error(`launchd could not stop ${INFERENCE_PROXY_LABEL}: ${result.output}`)
    return this.status()
  }

  /** The token never crosses into the renderer; true when there was one to copy. */
  copyProxyToken(): boolean {
    const token = this.readConfig().proxy_token
    if (token) this.copyText(token)
    return Boolean(token)
  }

  /** Applies a config change and restarts a running proxy, which reads its config only at start. */
  private async mutate(change: (config: ProxyConfig) => void): Promise<void> {
    const config = this.readConfig()
    const before = JSON.stringify(config)
    change(config)
    if (!config.proxy_token) config.proxy_token = randomBytes(32).toString('base64url')
    // The page's Enable button re-saves the current port; that must not rewrite the proxy's file or restart it.
    if (JSON.stringify(config) === before) return
    // Private, atomic write: the file holds every upstream key and the proxy token.
    mkdirSync(dirname(this.paths.configFile), { recursive: true, mode: 0o700 })
    const tmp = `${this.paths.configFile}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.paths.configFile)
    const running = await this.launchdState()
    if (running.service === 'running') {
      // Silently ignoring a failed restart would leave the old config serving while the page shows the new one.
      const restart = await this.run('/bin/launchctl', ['kickstart', '-k', `${this.domain}/${INFERENCE_PROXY_LABEL}`])
      if (!restart.ok) throw new Error(`Saved, but launchd could not restart ${INFERENCE_PROXY_LABEL}: ${restart.output}`)
      // kickstart -k returns before the old instance has exited, so an immediate /healthz probe could be
      // answered by the old process. Wait for launchd to show a new pid, then for that instance to answer.
      await this.waitUntil(async () => (await this.launchdState()).pid !== running.pid)
      await this.waitUntil(() => this.probeHealth(config.port))
    }
  }

  private readConfig(): ProxyConfig {
    const raw: Partial<ProxyConfig> = existsSync(this.paths.configFile)
      ? JSON.parse(readFileSync(this.paths.configFile, 'utf8')) as Partial<ProxyConfig>
      : {}
    return {
      ...raw,
      upstream_base_url: typeof raw.upstream_base_url === 'string' ? raw.upstream_base_url : INFERENCE_PROXY_UPSTREAM,
      // Remote servers come in through SSH reverse forwards, so a config created here stays on loopback.
      host: typeof raw.host === 'string' ? raw.host : '127.0.0.1',
      port: typeof raw.port === 'number' ? raw.port : INFERENCE_PROXY_DEFAULT_PORT,
      proxy_token: typeof raw.proxy_token === 'string' ? raw.proxy_token : '',
      keys: Array.isArray(raw.keys) ? raw.keys : []
    }
  }

  /** launchd's view of the service; the pid identifies the running instance across a restart. */
  private async launchdState(): Promise<{ service: InferenceProxyStatus['service']; pid: number | null }> {
    if (!existsSync(this.paths.plistFile)) return { service: 'not-installed', pid: null }
    const result = await this.run('/bin/launchctl', ['print', `${this.domain}/${INFERENCE_PROXY_LABEL}`])
    if (!result.ok || !/\bstate = running\b/.test(result.output)) return { service: 'stopped', pid: null }
    const pid = Number(result.output.match(/\bpid = (\d+)/)?.[1])
    return { service: 'running', pid: Number.isInteger(pid) ? pid : null }
  }

  /** Polls `ready` until it holds or the start timeout passes; false on timeout. */
  private async waitUntil(ready: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs
    while (!await ready()) {
      if (Date.now() >= deadline) return false
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return true
  }

  /** null when no local hub is installed: install.sh writes this file, and without a hub there are no remote servers to forward to. */
  private readHubEnv(): string | null {
    try { return readFileSync(this.paths.hubEnvFile, 'utf8') } catch { return null }
  }

  private writeHubForwardPort(port: number): void {
    const text = this.readHubEnv()
    if (text === null) return
    const line = `export ${INFERENCE_PROXY_PORT_ENV}=${port}`
    const existing = new RegExp(`^(?:export\\s+)?${INFERENCE_PROXY_PORT_ENV}=.*$`, 'm')
    const next = existing.test(text)
      ? text.replace(existing, line)
      : `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n# Inference proxy port, reverse-forwarded to every remote server (remote_servers.Tunnel).\n${line}\n`
    if (next !== text) writeFileSync(this.paths.hubEnvFile, next)
  }
}

function indexOfKey(config: ProxyConfig, name: string): number {
  const index = config.keys.findIndex(entry => entry.name === name)
  if (index < 0) throw new Error(`No key named ${name}.`)
  return index
}

const runCommand: RunCommand = (file, args) => new Promise(resolve => {
  execFile(file, args, { encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) => {
    resolve({ ok: !error, output: `${stdout}${stderr}`.trim() || error?.message || '' })
  })
})

async function probeHealth(port: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal })).ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
