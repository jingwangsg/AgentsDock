import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { SSH_HOST_ALIAS_PATTERN } from '../shared/ssh-host-alias'
import { sshDestination, writeSshHost, writeTunnelSshHost } from './ssh-hosts'

/** The part of OpenInZedRequest the CLI launch needs; the rest routes the tunnel in AppService. */
export interface OpenInZedInput {
  /** Absolute path on the server that owns the chat. */
  path: string
  line?: number
  column?: number
  /** SSH destination of that server; omitted for a server on this machine. */
  sshHost?: string | null
  /** The local SSH alias this Mac keeps for that server (Forward SSH); the URL names it instead of the raw host. */
  hostAlias?: string | null
}

const ZED_DATABASE = `${homedir()}/Library/Application Support/Zed/db/0-stable/db.sqlite`

const ZED_CLI_CANDIDATES = [
  '/usr/local/bin/zed',
  '/opt/homebrew/bin/zed',
  `${homedir()}/.local/bin/zed`,
  // The CLI that ships inside the app bundle, for installs that never ran "Install CLI".
  '/Applications/Zed.app/Contents/MacOS/cli'
]

/** Builds the single argument handed to the Zed CLI: a local path or an ssh:// URL. */
export function zedTarget(input: OpenInZedInput): string {
  const path = input.path.trim()
  if (!path.startsWith('/')) throw new Error('Open in Zed needs an absolute path.')
  // Zed reads a trailing `:line:column` from a local path and from an ssh:// URL alike.
  const location = input.line ? `:${input.line}${input.column ? `:${input.column}` : ''}` : ''
  const sshHost = input.sshHost?.trim() || ''
  if (!sshHost) return `${path}${location}`
  const alias = input.hostAlias?.trim() || ''
  if (alias && !SSH_HOST_ALIAS_PATTERN.test(alias)) throw new Error('The SSH host alias for this server is invalid.')
  const destination = alias || sshDestination(sshHost)
  // Zed parses this with url::Url and percent-decodes the path, so `#`, `?` and `%` in a directory name must be encoded.
  return `ssh://${destination}${path.split('/').map(encodeURIComponent).join('/')}${location}`
}

/**
 * Folders of the workspaces Zed has open now on the machine `input` names (this Mac without an SSH host),
 * as zedTarget names that machine. Zed has no command that lists them; its state database marks an open
 * workspace with the running session's id. Empty when Zed is not running or the database cannot be read.
 */
export async function openZedWorkspaceFolders(input: Pick<OpenInZedInput, 'sshHost' | 'hostAlias'>, database = ZED_DATABASE): Promise<string[]> {
  // Workspaces keep that id after Zed quits, so they reopen on its next start.
  if (!await new Promise<boolean>(resolve => execFile('pgrep', ['-x', 'zed'], error => resolve(!error)))) return []
  let connection: DatabaseSync | undefined
  try {
    const sshHost = input.sshHost?.trim()
    const destination = sshHost ? input.hostAlias?.trim() || sshDestination(sshHost) : null
    connection = new DatabaseSync(database, { readOnly: true })
    const workspaces = connection.prepare(`
      select w.paths, r.host, r.user, r.port from workspaces w left join remote_connections r on r.id = w.remote_connection_id
      where w.session_id = (select value from kv_store where key = 'session_id')
    `).all() as Array<{ paths: string | null; host: string | null; user: string | null; port: number | null }>
    return workspaces
      .filter(({ host, user, port }) => (host === null ? null : `${user ? `${user}@` : ''}${host}${port ? `:${port}` : ''}`) === destination)
      .flatMap(workspace => (workspace.paths ?? '').split('\n').filter(Boolean))
  } catch {
    return []
  } finally {
    connection?.close()
  }
}

export function findZedCli(candidates: readonly string[] = ZED_CLI_CANDIDATES): string | null {
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/**
 * Launches Zed on the path. `tunnelPort` is the local port of AgentsDock's tunnel to the remote's
 * sshd; without it (a server from before that tunnel) the alias copies the host's own ssh entry.
 */
export async function openInZed(input: OpenInZedInput, tunnelPort?: number): Promise<void> {
  const target = zedTarget(input)
  const cli = findZedCli()
  if (!cli) throw new Error('Zed CLI not found. Install Zed and run "Install CLI" from its Zed menu.')
  const alias = input.hostAlias?.trim()
  const sshHost = input.sshHost?.trim()
  // The alias file carries how this Mac reaches the host now (the tunnel's port, or a Sky cluster's
  // resolved address and keys); a change between opens must not strand Zed, so it is rewritten
  // right before Zed connects.
  if (alias && sshHost) await (tunnelPort === undefined ? writeSshHost(alias, sshHost) : writeTunnelSshHost(alias, sshHost, tunnelPort))
  await new Promise<void>((resolve, reject) => {
    execFile(cli, [target], { timeout: 15_000 }, error => (error ? reject(error) : resolve()))
  })
}
