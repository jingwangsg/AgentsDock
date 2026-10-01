import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { PublicServerProfile, RemoteServer } from '../shared/types'
import { DEFAULT_SERVER_URL, normalizeServerURL } from '../shared/server-url'

/** Mirrors server/agent_server.py parse_config_env_file: KEY=VALUE, optional `export `, quotes, malformed lines skipped. */
export function parseConfigEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart()
    const separator = line.indexOf('=')
    if (separator < 0) continue
    const name = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    let value = line.slice(separator + 1).trim()
    const quote = value[0]
    if (value.length >= 2 && (quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      if (quote === '"') {
        try {
          const decoded: unknown = JSON.parse(value)
          value = typeof decoded === 'string' ? decoded : value.slice(1, -1)
        } catch { value = value.slice(1, -1) }
      } else value = value.slice(1, -1)
    }
    values[name] = value
  }
  return values
}

/** Token install.sh wrote for the local server, or '' when the file or key is absent or malformed. */
export function readLocalHubToken(
  configDir = process.env.AGENTS_SERVER_CONFIG_DIR || join(homedir(), '.config', 'agents-server')
): string {
  let text: string
  try { text = readFileSync(join(configDir, 'env'), 'utf8') } catch { return '' }
  const token = parseConfigEnv(text).AGENTSDOCK_AGENT_TOKEN ?? ''
  return token.length >= 32 && !/\s/.test(token) ? token : ''
}

export interface HubRemotePlan {
  add: Array<{ name: string; serverUrl: string; sshHost: string }>
  update: Array<{ id: string; sshHost: string }>
  remove: string[]
}

/** A `<hub>/api/remote/<id>` URL: the hub, not the URL, decides which server answers there. */
export function isHubRemoteUrl(hubUrl: string, serverUrl: string): boolean {
  return normalizeServerURL(serverUrl).startsWith(`${normalizeServerURL(hubUrl)}/api/remote/`)
}

/** The registry id in a `<hub>/api/remote/<id>` URL; null for any other server. */
export function hubRemoteId(hubUrl: string, serverUrl: string): string | null {
  const prefix = `${normalizeServerURL(hubUrl)}/api/remote/`
  const url = normalizeServerURL(serverUrl)
  return url.startsWith(prefix) ? url.slice(prefix.length) : null
}

/** Profile ids with this hub's remotes in registry order, in the places they already hold; null when nothing moves. */
export function hubRemoteProfileOrder(hubUrl: string, remotes: readonly RemoteServer[], profiles: readonly PublicServerProfile[]): string[] | null {
  const rank = new Map(remotes.map((remote, index) => [remote.id, index]))
  const rankOf = (profile: PublicServerProfile) => rank.get(hubRemoteId(hubUrl, profile.serverUrl) ?? '')
  const current = profiles.filter(profile => rankOf(profile) !== undefined)
  const sorted = [...current].sort((a, b) => rankOf(a)! - rankOf(b)!)
  if (sorted.every((profile, index) => profile === current[index])) return null
  const queue = sorted.values()
  return profiles.map(profile => rankOf(profile) === undefined ? profile.id : queue.next().value!.id)
}

/** Stored profiles under `<hub>/api/remote/` must equal the hub registry; every other profile is left alone. */
export function planHubRemoteProfiles(
  hubUrl: string,
  remotes: readonly RemoteServer[],
  profiles: readonly PublicServerProfile[]
): HubRemotePlan {
  const hub = normalizeServerURL(hubUrl)
  const wanted = new Map(remotes.map(remote => [normalizeServerURL(`${hub}${remote.proxy_path}`), remote]))
  const plan: HubRemotePlan = { add: [], update: [], remove: [] }
  for (const profile of profiles) {
    const serverUrl = normalizeServerURL(profile.serverUrl)
    if (!isHubRemoteUrl(hub, serverUrl)) continue
    const remote = wanted.get(serverUrl)
    if (!remote) { plan.remove.push(profile.id); continue }
    wanted.delete(serverUrl)
    if ((profile.sshHost ?? '') !== remote.ssh_host) plan.update.push({ id: profile.id, sshHost: remote.ssh_host })
  }
  for (const [serverUrl, remote] of wanted) plan.add.push({ name: remote.name, serverUrl, sshHost: remote.ssh_host })
  return plan
}

const TAILSCALE_BINARIES = ['/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']

/** Address a phone uses to reach this hub: the tailnet name or IP, else the first LAN IPv4. */
export async function localHubPairingUrl(): Promise<string | null> {
  for (const binary of TAILSCALE_BINARIES) {
    const host = await new Promise<string | null>(resolve => {
      execFile(binary, ['status', '--self', '--json'], { encoding: 'utf8', timeout: 3_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(null)
        try {
          const self = (JSON.parse(stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }).Self
          resolve(self?.DNSName?.replace(/\.$/, '') || self?.TailscaleIPs?.[0] || null)
        } catch { resolve(null) }
      })
    })
    if (host) return `http://${host}:7850`
  }
  for (const entries of Object.values(networkInterfaces())) {
    const address = entries?.find(entry => entry.family === 'IPv4' && !entry.internal)?.address
    if (address) return `http://${address}:7850`
  }
  return null
}

/** install.sh's LaunchAgent first, then the hand-written one that runs a source checkout. */
const LOCAL_SERVER_LAUNCH_AGENTS = ['com.agentsdock.server', 'com.agentsdock.local-server']
const LOCAL_SERVER_START_TIMEOUT_MS = 20_000

/**
 * Starts the local server's LaunchAgent (loading its plist first when launchd has not, e.g. right after login)
 * and resolves once the server port accepts connections.
 */
export async function startLocalServerAgent(
  agentsDir = join(homedir(), 'Library', 'LaunchAgents'),
  labels: readonly string[] = LOCAL_SERVER_LAUNCH_AGENTS,
  serverUrl = DEFAULT_SERVER_URL
): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('Starting the local server is only supported on macOS.')
  const label = labels.find(candidate => existsSync(join(agentsDir, `${candidate}.plist`)))
  if (!label) throw new Error(`No AgentsServer LaunchAgent in ${agentsDir} (looked for ${labels.map(name => `${name}.plist`).join(', ')}).`)
  const domain = `gui/${process.getuid?.()}`
  // Resolves to launchctl's error text, or null on success.
  const launchctl = (...args: string[]) => new Promise<string | null>(resolve => {
    execFile('/bin/launchctl', args, { encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) => {
      resolve(error ? stderr.trim() || stdout.trim() || error.message : null)
    })
  })
  // Without -k, kickstart leaves a running server alone; it fails when launchd has not loaded the plist.
  if (await launchctl('kickstart', `${domain}/${label}`)) {
    const failure = await launchctl('bootstrap', domain, join(agentsDir, `${label}.plist`))
      ?? await launchctl('kickstart', `${domain}/${label}`)
    if (failure) throw new Error(`launchd could not start ${label}: ${failure}`)
  }

  const { hostname, port } = new URL(serverUrl)
  const deadline = Date.now() + LOCAL_SERVER_START_TIMEOUT_MS
  while (!await new Promise<boolean>(resolve => {
    const socket = connect({ host: hostname, port: Number(port) })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })) {
    if (Date.now() >= deadline) {
      throw new Error(`launchd started ${label}, but nothing accepted connections on ${hostname}:${port} within ${LOCAL_SERVER_START_TIMEOUT_MS / 1000} s. Check that service's log.`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}
