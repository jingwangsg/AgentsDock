import type { PublicServerProfile, Session } from './types'

/** A local SSH host alias AgentsDock may write for a server: its profile name, when it is a plain host name such as `oci_dev`. */
export const SSH_HOST_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** The alias this Mac keeps for the profile's server while Forward SSH is on, else null. */
export function sshHostAlias(profile: Pick<PublicServerProfile, 'name' | 'sshHost' | 'sshForward'>): string | null {
  return profile.sshForward && profile.sshHost && SSH_HOST_ALIAS_PATTERN.test(profile.name) ? profile.name : null
}

/**
 * What Open in Zed needs for a chat: its directory on the server, and how this Mac reaches that
 * server. A remote is always named by its alias (written right before Zed connects): Zed runs
 * without the shell environment a Sky cluster's own ssh entry relies on, and the alias carries it.
 */
export function openInZedInput(session: Pick<Session, 'cwd'>, profile: PublicServerProfile | undefined): { path: string; sshHost: string | null; hostAlias: string | null } | null {
  const path = session.cwd?.trim()
  if (!path) return null
  const sshHost = profile?.sshHost ?? null
  const hostAlias = profile && sshHost && SSH_HOST_ALIAS_PATTERN.test(profile.name) ? profile.name : null
  return { path, sshHost, hostAlias }
}
