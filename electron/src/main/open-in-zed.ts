import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { SSH_HOST_ALIAS_PATTERN } from '../shared/ssh-host-alias'
import { sshDestination, writeSshHost } from './ssh-hosts'

export interface OpenInZedInput {
  /** Absolute path on the server that owns the chat. */
  path: string
  /** SSH destination of that server; omitted for a server on this machine. */
  sshHost?: string | null
  /** The local SSH alias this Mac keeps for that server (Forward SSH); the URL names it instead of the raw host. */
  hostAlias?: string | null
}

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
  const sshHost = input.sshHost?.trim() || ''
  if (!sshHost) return path
  const alias = input.hostAlias?.trim() || ''
  if (alias && !SSH_HOST_ALIAS_PATTERN.test(alias)) throw new Error('The SSH host alias for this server is invalid.')
  const destination = alias || sshDestination(sshHost)
  // Zed parses this with url::Url and percent-decodes the path, so `#`, `?` and `%` in a directory name must be encoded.
  return `ssh://${destination}${path.split('/').map(encodeURIComponent).join('/')}`
}

export function findZedCli(candidates: readonly string[] = ZED_CLI_CANDIDATES): string | null {
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

export async function openInZed(input: OpenInZedInput): Promise<void> {
  const target = zedTarget(input)
  const cli = findZedCli()
  if (!cli) throw new Error('Zed CLI not found. Install Zed and run "Install CLI" from its Zed menu.')
  // The alias file carries the host's resolved address and keys; a Sky cluster's change between
  // opens must not strand Zed, so the file is rewritten right before Zed connects.
  if (input.hostAlias?.trim() && input.sshHost?.trim()) await writeSshHost(input.hostAlias.trim(), input.sshHost.trim())
  await new Promise<void>((resolve, reject) => {
    execFile(cli, [target], { timeout: 15_000 }, error => (error ? reject(error) : resolve()))
  })
}
