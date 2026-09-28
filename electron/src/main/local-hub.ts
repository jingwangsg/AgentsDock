import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { PublicServerProfile, RemoteServer } from '../shared/types'
import { normalizeServerURL } from '../shared/server-url'

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

/** Stored profiles under `<hub>/api/remote/` must equal the hub registry; every other profile is left alone. */
export function planHubRemoteProfiles(
  hubUrl: string,
  remotes: readonly RemoteServer[],
  profiles: readonly PublicServerProfile[]
): HubRemotePlan {
  const hub = normalizeServerURL(hubUrl)
  const prefix = `${hub}/api/remote/`
  const wanted = new Map(remotes.map(remote => [normalizeServerURL(`${hub}${remote.proxy_path}`), remote]))
  const plan: HubRemotePlan = { add: [], update: [], remove: [] }
  for (const profile of profiles) {
    const serverUrl = normalizeServerURL(profile.serverUrl)
    if (!serverUrl.startsWith(prefix)) continue
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
