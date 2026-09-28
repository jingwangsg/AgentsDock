import { normalizeServerURL } from './format'
import { defaultProfileName } from './server-profiles'

export type ServerProfileConnectionState = 'online' | 'degraded' | 'connecting' | 'retrying' | 'offline' | 'cached'

/**
 * Structural view model consumed by the server-profile UI. The mobile store can
 * pass its public profile type directly or adapt differently named fields at
 * the AppShell boundary.
 */
export interface ServerProfileListItem {
  id: string
  name: string
  serverUrl: string
  serverIdentity?: string | null
  hasAccessToken: boolean
  serverSetupComplete: boolean
  connectionState: ServerProfileConnectionState
  cachedUnreadCount: number
  lastConnectionError?: string | null
  serverVersion?: string | null
}

export interface ServerProfileDraftValues {
  profileId: string
  name: string
  serverUrl: string
  accessToken: string
  clearAccessToken: boolean
  resetServerIdentity: boolean
}

export interface ServerProfileTestInput {
  profileId?: string
  serverUrl: string
  accessToken?: string | null
}

export interface ServerConnectionTestResult {
  ok: boolean
  server_identity?: string | null
  version?: string | null
  message?: string | null
}

/** One line of a hub deploy job's log (server/remote_servers.py `DeployJob.log`), without its `at` timestamp - the UI only orders and displays them. */
export interface RemoteDeployProgressEntry {
  phase: string
  message: string
}

export interface UpdateServerProfileInput {
  name?: string
  serverUrl?: string
  /** Undefined preserves the stored credential; null removes it. */
  accessToken?: string | null
  /** Identity returned by the successful test for this exact connection edit. */
  serverIdentity?: string
  resetServerIdentity?: boolean
}

export type ServerProfileEditorInitialMode = 'manage' | 'edit-active'

export function editServerProfileDraft(profile: ServerProfileListItem): ServerProfileDraftValues {
  // The first-launch placeholder still points at 127.0.0.1; blank fields show
  // the hub placeholders instead of asking the user to edit the loopback address.
  const configured = profile.serverSetupComplete
  return {
    profileId: profile.id,
    name: configured ? profile.name : '',
    serverUrl: configured ? profile.serverUrl : '',
    // Never place a saved credential back in React state. Blank means preserve.
    accessToken: '',
    clearAccessToken: false,
    resetServerIdentity: false,
  }
}

export function initialServerProfileDraft(
  mode: ServerProfileEditorInitialMode,
  profiles: readonly ServerProfileListItem[],
  activeProfileId: string | null,
): ServerProfileDraftValues | null {
  if (mode !== 'edit-active') return null
  const active = profiles.find(profile => profile.id === activeProfileId)
  return active ? editServerProfileDraft(active) : null
}

export function serverProfileHost(serverUrl: string): string | null {
  const clean = serverUrl.trim()
  if (!clean) return null
  try {
    const parsed = new URL(/^https?:\/\//i.test(clean) ? clean : `http://${clean}`)
    return parsed.host || null
  } catch {
    return null
  }
}

export function profileHostSubtitle(profile: Pick<ServerProfileListItem, 'name' | 'serverUrl' | 'serverIdentity'>): string | null {
  const host = serverProfileHost(profile.serverUrl)
  if (!host) return null
  const normalizedHost = host.toLocaleLowerCase()
  if (profile.name.trim().toLocaleLowerCase() === normalizedHost) return null
  if (profile.serverIdentity?.trim().toLocaleLowerCase() === normalizedHost) return null
  return host
}

export function connectionStateLabel(state: ServerProfileConnectionState): string {
  if (state === 'online') return 'Online'
  if (state === 'degraded') return 'Degraded'
  if (state === 'connecting') return 'Connecting'
  if (state === 'retrying') return 'Retrying'
  if (state === 'offline') return 'Offline'
  return 'Cached'
}

export function profileConnectionLabel(profile: Pick<ServerProfileListItem, 'connectionState' | 'lastConnectionError'>): string {
  if (profile.lastConnectionError && /\b(?:401|403|unauthori[sz]ed|forbidden|authentication|access token|bad token|invalid token)\b/i.test(profile.lastConnectionError)) {
    return 'Authentication required'
  }
  const label = connectionStateLabel(profile.connectionState)
  return profile.lastConnectionError ? `${label}: ${profile.lastConnectionError}` : label
}

export function unreadCountLabel(count: number): string {
  return count > 99 ? '99+' : String(Math.max(0, count))
}

export function findProfileByIdentity(
  profiles: readonly ServerProfileListItem[],
  serverIdentity?: string | null,
  excludeProfileId?: string | null,
): ServerProfileListItem | null {
  if (!serverIdentity) return null
  return profiles.find(profile => profile.id !== excludeProfileId && profile.serverIdentity === serverIdentity) ?? null
}

export function reorderedServerProfileIds(
  profiles: readonly Pick<ServerProfileListItem, 'id'>[],
  profileId: string,
  direction: -1 | 1,
): string[] | null {
  const index = profiles.findIndex(profile => profile.id === profileId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= profiles.length) return null
  const ids = profiles.map(profile => profile.id)
  ;[ids[index], ids[target]] = [ids[target], ids[index]]
  return ids
}

export function draftAccessToken(draft: Pick<ServerProfileDraftValues, 'accessToken' | 'clearAccessToken'>): string | null | undefined {
  if (draft.clearAccessToken) return null
  return draft.accessToken.trim() ? draft.accessToken : undefined
}

export function buildUpdateServerProfileInput(
  profile: ServerProfileListItem,
  draft: ServerProfileDraftValues,
  testedServerIdentity?: string | null,
): UpdateServerProfileInput {
  const patch: UpdateServerProfileInput = {}
  const serverUrl = normalizeServerURL(draft.serverUrl)
  // A blank name derives from the new address, so the first-launch
  // placeholder does not keep its "127.0.0.1" name after the hub is entered.
  const name = draft.name.trim() || defaultProfileName(serverUrl)
  const accessToken = draftAccessToken(draft)
  if (name !== profile.name) patch.name = name
  if (serverUrl !== profile.serverUrl) patch.serverUrl = serverUrl
  if (accessToken !== undefined) patch.accessToken = accessToken
  if (draft.resetServerIdentity) patch.resetServerIdentity = true
  const changesConnection = patch.serverUrl !== undefined || patch.accessToken !== undefined || patch.resetServerIdentity === true
  const identity = testedServerIdentity?.trim()
  if (changesConnection && identity) patch.serverIdentity = identity
  return patch
}

export function requiresIdentityResetConfirmation(profile: Pick<ServerProfileListItem, 'serverIdentity' | 'lastConnectionError'>): boolean {
  return Boolean(profile.serverIdentity && /server identity (?:changed|mismatch)/i.test(profile.lastConnectionError ?? ''))
}
