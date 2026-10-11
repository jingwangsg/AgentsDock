import type { PublicServerProfile, Session } from './types'

/** A local SSH host alias AgentsDock may write for a server: its profile name, when it is a plain host name such as `oci_dev`. */
export const SSH_HOST_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** The alias this Mac keeps for the profile's server while Forward SSH is on, else null. */
export function sshHostAlias(profile: Pick<PublicServerProfile, 'name' | 'sshHost' | 'sshForward'>): string | null {
  return profile.sshForward && profile.sshHost && SSH_HOST_ALIAS_PATTERN.test(profile.name) ? profile.name : null
}

export interface OpenInZedRequest {
  /** Absolute path on the server that owns the chat. */
  path: string
  /** SSH destination of that server; null for a server on this machine. */
  sshHost: string | null
  /** The local SSH alias this Mac keeps for that server; the URL names it instead of the raw host. */
  hostAlias: string | null
  /** The chat and its server: a remote's sshd is reached through a port tunnel the server opens for that chat. */
  sessionId: string
  profileId: string
  profileGeneration: number
}

/**
 * What Open in Zed needs for a chat: its directory on the server, and how this Mac reaches that
 * server. A remote is always named by its alias (written right before Zed connects): Zed runs
 * without the shell environment a Sky cluster's own ssh entry relies on, and the alias carries it.
 */
export function openInZedInput(session: Pick<Session, 'id' | 'cwd'>, profile: PublicServerProfile | undefined, profileGeneration: number): OpenInZedRequest | null {
  const path = session.cwd?.trim()
  if (!path || !profile) return null
  const sshHost = profile.sshHost ?? null
  const hostAlias = sshHost && SSH_HOST_ALIAS_PATTERN.test(profile.name) ? profile.name : null
  return { path, sshHost, hostAlias, sessionId: session.id, profileId: profile.id, profileGeneration }
}
