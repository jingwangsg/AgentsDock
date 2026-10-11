import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { SSH_HOST_ALIAS_PATTERN } from '../shared/ssh-host-alias'
import { PORT_TUNNEL_LOOPBACK_HOST, PORT_TUNNEL_SSH_PORT } from './port-tunnel-manager'

/**
 * SkyPilot's websocket ssh proxy verifies the API server's certificate against this bundle, which
 * `sky` points at through SSL_CERT_FILE / REQUESTS_CA_BUNDLE in a shell; a process without that
 * environment (Zed, anything launched from the Dock) is refused. Null when no bundle is installed.
 */
export function skyCaBundle(): string | null {
  const bundle = join(homedir(), '.sky', 'certs', 'requests-ca-bundle.pem')
  return existsSync(bundle) ? bundle : null
}

/**
 * Local SSH host aliases for remote servers, kept the way SkyPilot keeps its clusters: one file
 * per alias under a directory the user's SSH config includes. `ssh oci_dev` and Zed's
 * `ssh://oci_dev/…` then reach the server behind the hub's `oci@<cluster>` notation.
 */
export interface SshHostPaths {
  hostsDir: string
  sshConfig: string
}

export function defaultSshHostPaths(): SshHostPaths {
  return { hostsDir: join(homedir(), '.agentsdock', 'ssh'), sshConfig: join(homedir(), '.ssh', 'config') }
}

const SSH_DESTINATION_PATTERN = /^[A-Za-z0-9_.@%+:[\]-]+$/

/** The SSH destination behind a hub notation: `oci@<cluster>` and `aws@<cluster>` name the Sky alias itself; an osmo@ workflow has none. */
export function sshDestination(sshHost: string): string {
  const host = sshHost.trim()
  if (host.startsWith('osmo@')) throw new Error('An osmo@ workflow is reached through `osmo workflow exec`; it has no plain SSH host.')
  const destination = host.replace(/^(oci|aws)@/, '')
  if (!destination || destination.startsWith('-') || !SSH_DESTINATION_PATTERN.test(destination)) throw new Error('The SSH host for this server is invalid.')
  return destination
}

export type RunSsh = (args: string[]) => Promise<string>
const runSsh: RunSsh = args => new Promise((resolve, reject) => {
  execFile('ssh', args, { timeout: 15_000, maxBuffer: 1 << 20 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
})

/** `ssh -G <destination>`: every option as the client would use it, hostname, keys and ProxyCommand included. */
export async function resolvedSshOptions(destination: string, run: RunSsh = runSsh): Promise<Map<string, string[]>> {
  const options = new Map<string, string[]>()
  for (const line of (await run(['-G', destination])).split('\n')) {
    const space = line.indexOf(' ')
    if (space <= 0) continue
    const key = line.slice(0, space).toLowerCase()
    options.set(key, [...(options.get(key) ?? []), line.slice(space + 1)])
  }
  return options
}

// The options SkyPilot writes for a cluster, in its order; `ssh -G` names them in lower case.
const COPIED_OPTIONS: ReadonlyArray<readonly [key: string, name: string]> = [
  ['hostname', 'HostName'], ['user', 'User'], ['port', 'Port'], ['identityfile', 'IdentityFile'],
  ['identitiesonly', 'IdentitiesOnly'], ['forwardagent', 'ForwardAgent'], ['stricthostkeychecking', 'StrictHostKeyChecking'],
  ['userknownhostsfile', 'UserKnownHostsFile'], ['globalknownhostsfile', 'GlobalKnownHostsFile'], ['setenv', 'SetEnv'],
  ['serveraliveinterval', 'ServerAliveInterval'], ['proxyjump', 'ProxyJump'], ['proxycommand', 'ProxyCommand']
]

/**
 * The host block for `alias`, resolved from `sshHost` so the alias works even when that host is
 * a Sky cluster name. A Sky websocket proxy command gets the certificate environment inline, so
 * the alias connects from any process.
 */
export function sshHostFileContent(alias: string, sshHost: string, options: ReadonlyMap<string, string[]>, caBundle: string | null = skyCaBundle()): string {
  requireAlias(alias)
  const lines = [
    `# Added by AgentsDock for the server "${alias}" (SSH host ${sshHost.trim()}). Rewritten when that server is opened or changes; turning off Forward SSH removes it.`,
    `Host ${alias}`
  ]
  for (const [key, name] of COPIED_OPTIONS) {
    for (const raw of options.get(key) ?? []) {
      // ssh -G prints booleans as true/false; the config file wants yes/no.
      let value = key === 'stricthostkeychecking' ? raw === 'false' ? 'no' : raw === 'true' ? 'yes' : raw : raw
      if (key === 'proxycommand' && caBundle && value.includes('websocket_proxy.py')) {
        // `env` must run the ssh itself, not a leading `exec`; the inner ssh hands the variables to the proxy.
        const quoted = `'${caBundle.replace(/'/g, `'\\''`)}'`
        value = `env SSL_CERT_FILE=${quoted} REQUESTS_CA_BUNDLE=${quoted} ${value.replace(/^exec\s+/, '')}`
      }
      if (!value || value === 'none' || (key === 'serveraliveinterval' && value === '0')) continue
      lines.push(`  ${name} ${value}`)
    }
  }
  return lines.join('\n') + '\n'
}

// The host's own ssh entry still decides who logs in and with which key when the tunnel carries the connection.
const IDENTITY_OPTIONS: ReadonlyArray<readonly [key: string, name: string]> = [['user', 'User'], ['identityfile', 'IdentityFile'], ['identitiesonly', 'IdentitiesOnly']]

/**
 * The host block for `alias` while the server's sshd is reached through AgentsDock's port tunnel
 * on `localPort`: the tunnel replaces the host's address and proxy, so only the identity options
 * are kept from `options`. Host keys are not checked, since every server presents its own key on
 * the one loopback port.
 */
export function tunnelSshHostFileContent(alias: string, sshHost: string, localPort: number, options: ReadonlyMap<string, string[]>): string {
  requireAlias(alias)
  const lines = [
    `# Added by AgentsDock for the server "${alias}" (SSH host ${sshHost.trim()}). Reaches its sshd through AgentsDock's port tunnel, which exists only while AgentsDock runs. Rewritten when that server is opened in Zed; turning off Forward SSH removes it.`,
    `Host ${alias}`,
    `  HostName ${PORT_TUNNEL_LOOPBACK_HOST}`,
    `  Port ${localPort}`
  ]
  for (const [key, name] of IDENTITY_OPTIONS) for (const value of options.get(key) ?? []) lines.push(`  ${name} ${value}`)
  lines.push('  StrictHostKeyChecking no', '  UserKnownHostsFile /dev/null')
  return lines.join('\n') + '\n'
}

function requireAlias(alias: string): void {
  if (!SSH_HOST_ALIAS_PATTERN.test(alias)) throw new Error(`"${alias}" cannot be an SSH host alias: use letters, digits, "_", "-" or "." only.`)
}

/** Writes (or rewrites) the alias file and makes sure the SSH config includes the directory. */
export async function writeSshHost(alias: string, sshHost: string, paths: SshHostPaths = defaultSshHostPaths(), run: RunSsh = runSsh): Promise<string> {
  return writeSshHostFile(alias, sshHostFileContent(alias, sshHost, await resolvedSshOptions(sshDestination(sshHost), run)), paths)
}

/** Writes the alias so `ssh <alias>` and Zed reach the server's sshd through AgentsDock's port tunnel on `localPort`. */
export async function writeTunnelSshHost(alias: string, sshHost: string, localPort: number, paths: SshHostPaths = defaultSshHostPaths(), run: RunSsh = runSsh): Promise<string> {
  // An osmo@ workflow has no ssh entry to resolve; its sshd accepts root with the user's default keys, the way the hub logs in.
  const options = sshHost.trim().startsWith('osmo@') ? new Map([['user', ['root']]]) : await resolvedSshOptions(sshDestination(sshHost), run)
  // The server dials port 22 only, so a host whose sshd listens elsewhere keeps its own entry.
  const port = options.get('port')?.[0]
  const content = port && port !== String(PORT_TUNNEL_SSH_PORT) ? sshHostFileContent(alias, sshHost, options) : tunnelSshHostFileContent(alias, sshHost, localPort, options)
  return writeSshHostFile(alias, content, paths)
}

function writeSshHostFile(alias: string, content: string, paths: SshHostPaths): string {
  mkdirSync(paths.hostsDir, { recursive: true, mode: 0o700 })
  const file = join(paths.hostsDir, alias)
  writeFileSync(file, content, { mode: 0o600 })
  chmodSync(file, 0o600)
  ensureSshConfigInclude(paths)
  return file
}

export function removeSshHost(alias: string, paths: SshHostPaths = defaultSshHostPaths()): void {
  if (!SSH_HOST_ALIAS_PATTERN.test(alias)) return
  const file = join(paths.hostsDir, alias)
  if (existsSync(file)) unlinkSync(file)
}

/** The Include goes first, as SkyPilot's does: an Include after a matching Host block would not apply to it. */
export function ensureSshConfigInclude(paths: SshHostPaths): void {
  const home = homedir()
  const include = `Include ${paths.hostsDir.startsWith(`${home}/`) ? `~${paths.hostsDir.slice(home.length)}` : paths.hostsDir}/*`
  const existing = existsSync(paths.sshConfig) ? readFileSync(paths.sshConfig, 'utf8') : ''
  if (existing.split('\n').some(line => line.trim() === include)) return
  mkdirSync(dirname(paths.sshConfig), { recursive: true, mode: 0o700 })
  writeFileSync(paths.sshConfig, `${include}\n${existing}`, { mode: 0o600 })
  chmodSync(paths.sshConfig, 0o600)
}
