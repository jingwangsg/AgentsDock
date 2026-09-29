import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

export interface OpenInZedInput {
  /** Absolute path on the server that owns the chat. */
  path: string
  /** SSH destination of that server; omitted for a server on this machine. */
  sshHost?: string | null
}

const SSH_HOST_PATTERN = /^[A-Za-z0-9_.@%+:[\]-]+$/

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
  if (sshHost.startsWith('-') || !SSH_HOST_PATTERN.test(sshHost)) throw new Error('The SSH host for this server is invalid.')
  // Only the hub resolves its cluster notations: oci@<cluster> is the Sky alias itself, and an
  // osmo@ workflow is reached through `osmo workflow exec`, which a URL cannot express.
  if (sshHost.startsWith('osmo@')) throw new Error('Open in Zed cannot reach an osmo@ workflow: it has no plain SSH host.')
  const destination = sshHost.startsWith('oci@') ? sshHost.slice('oci@'.length) : sshHost
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
  await new Promise<void>((resolve, reject) => {
    execFile(cli, [target], { timeout: 15_000 }, error => (error ? reject(error) : resolve()))
  })
}
