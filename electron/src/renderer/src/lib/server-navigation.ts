import type { PublicServerProfile } from '@shared/types'

/** The servers offered for switching: a remote hidden on the hub stays out, unless it is the one in use. */
export function listedServerProfiles<T extends Pick<PublicServerProfile, 'id' | 'hidden'>>(profiles: readonly T[], activeProfileId: string | null): T[] {
  return profiles.filter(profile => !profile.hidden || profile.id === activeProfileId)
}

export function adjacentServerProfileId(
  profiles: readonly Pick<PublicServerProfile, 'id'>[],
  activeProfileId: string | null,
  direction: 1 | -1
): string | null {
  if (profiles.length < 2 || !activeProfileId) return null
  const current = profiles.findIndex(profile => profile.id === activeProfileId)
  if (current < 0) return null
  return profiles[(current + direction + profiles.length) % profiles.length]?.id ?? null
}
