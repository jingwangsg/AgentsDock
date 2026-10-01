import type { StoredProfileSettings, StoredServerProfile } from '../types'
import {
  applyStoredServerProfileUpdate,
  assertUniqueServerProfile,
  createStoredServerProfile,
  findDuplicateProfileByIdentity,
  findDuplicateProfileByURL,
  hubProxyRemoteId,
  hubRemoteProfileOrder,
  legacyURLCacheNamespace,
  migrateLegacyProfileSettings,
  nextCredentialVersion,
  normalizeCredentialVersion,
  normalizeStoredProfileSettings,
  profileCredentialKeySuffix,
  profileNamespace,
  reconcileHubProfiles,
} from './server-profiles'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

function assertThrows(action: () => unknown, pattern: RegExp): void {
  try { action() } catch (error) {
    assert(pattern.test(error instanceof Error ? error.message : String(error)), `Unexpected error: ${String(error)}`)
    return
  }
  throw new Error('Expected action to throw')
}

const timestamp = '2026-07-18T12:00:00.000Z'
const migrated = migrateLegacyProfileSettings({
  serverURL: 'SERVER.EXAMPLE:7850/api/health?ignored=1',
  serverConfigured: true,
  selectedSessionId: 'chat-1',
  folderOrder: ['Work', 'Work', 'Personal'],
  fontScale: 1.26,
}, timestamp)

assertEqual(migrated.settings, {
  schemaVersion: 2,
  activeProfileId: 'default-profile',
  profiles: [{
    id: 'default-profile',
    name: 'server.example',
    serverURL: 'http://server.example:7850',
    serverIdentity: null,
    serverConfigured: true,
    credentialVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  }],
  fontScale: 1.3,
  appearance: 'dark',
})
assertEqual(migrated.workspace, {
  selectedSessionId: 'chat-1',
  folderOrder: ['Work', 'Personal'],
  collapsedFolders: [],
  drafts: {},
})

// Normalizing an already-migrated value neither creates a new ID nor rewrites timestamps.
assertEqual(normalizeStoredProfileSettings(migrated.settings, '2030-01-01T00:00:00.000Z'), migrated.settings)
// Appearance survives a round trip; settings saved before it existed, or with a
// value this build does not know, open in the default Zed One Dark.
for (const appearance of ['system', 'light', 'dark'] as const) {
  assertEqual(normalizeStoredProfileSettings({ ...migrated.settings, appearance }).appearance, appearance)
}
const { appearance: _omitted, ...settingsWithoutAppearance } = migrated.settings
assertEqual(normalizeStoredProfileSettings(settingsWithoutAppearance).appearance, 'dark')
assertEqual(normalizeStoredProfileSettings({ ...migrated.settings, appearance: 'sepia' }).appearance, 'dark')
assertEqual(profileNamespace(migrated.settings.profiles[0]), 'profile:default-profile')
assertEqual(profileNamespace({ id: 'default-profile', serverIdentity: ' canonical-server ' }), 'canonical-server')
assertEqual(legacyURLCacheNamespace(migrated.settings.profiles[0].serverURL), 'http://server.example:7850')

assertEqual(normalizeCredentialVersion(undefined), 1)
assertEqual(normalizeCredentialVersion(0), 1)
assertEqual(normalizeCredentialVersion(7), 7)
assertEqual(nextCredentialVersion(7), 8)
assertThrows(() => nextCredentialVersion(Number.MAX_SAFE_INTEGER), /cannot be advanced/)

const settingsWithoutCredentialVersion = JSON.parse(JSON.stringify(migrated.settings)) as {
  profiles: Array<Record<string, unknown>>
}
delete settingsWithoutCredentialVersion.profiles[0].credentialVersion
assertEqual(normalizeStoredProfileSettings(settingsWithoutCredentialVersion).profiles[0].credentialVersion, 1)

const secureSuffix = profileCredentialKeySuffix('profile/a ☃')
assert(/^[A-Za-z0-9._-]+$/.test(secureSuffix), 'SecureStore suffix contains unsupported characters')
assert(secureSuffix !== profileCredentialKeySuffix('profile-a ☃'), 'credential suffixes must not collapse distinct profile IDs')

const profileA = createStoredServerProfile({
  name: 'Alpha',
  serverURL: 'alpha.example:7850',
  serverIdentity: 'server-alpha',
  serverConfigured: true,
}, 'profile-a', timestamp)
const profileB = createStoredServerProfile({ serverURL: 'beta.example:7850' }, 'profile-b', timestamp)
assertEqual(profileA.serverURL, 'http://alpha.example:7850')
assertEqual(profileB.name, 'beta.example')
assertEqual(findDuplicateProfileByURL([profileA, profileB], 'HTTP://ALPHA.EXAMPLE:7850/')?.id, 'profile-a')
assertEqual(findDuplicateProfileByIdentity([profileA, profileB], ' server-alpha ')?.id, 'profile-a')

// Two remotes proxied through the same hub differ only by their /api/remote/{id}
// path; reconcileHubRemoteServers must not treat one as a duplicate of the other.
const hubRemoteOne = createStoredServerProfile({ serverURL: 'http://127.0.0.1:7850/api/remote/aaa111' }, 'remote-one', timestamp)
const hubRemoteTwo = createStoredServerProfile({ serverURL: 'http://127.0.0.1:7850/api/remote/bbb222' }, 'remote-two', timestamp)
assertEqual(findDuplicateProfileByURL([hubRemoteOne, hubRemoteTwo], 'http://127.0.0.1:7850/api/remote/aaa111/'), hubRemoteOne)
assertEqual(findDuplicateProfileByURL([hubRemoteOne, hubRemoteTwo], 'http://127.0.0.1:7850/api/remote/ccc333'), undefined)
assertThrows(() => assertUniqueServerProfile([profileA, profileB], {
  serverURL: 'alpha.example:7850',
  serverIdentity: null,
}), /already uses/)
assertThrows(() => assertUniqueServerProfile([profileA, profileB], {
  serverURL: 'gamma.example:7850',
  serverIdentity: 'server-alpha',
}), /already belongs/)

const updated = applyStoredServerProfileUpdate(profileA, {
  name: 'Renamed',
  serverURL: 'new-alpha.example:7850',
  resetServerIdentity: true,
}, '2026-07-18T13:00:00.000Z')
assertEqual(updated, {
  ...profileA,
  name: 'Renamed',
  serverURL: 'http://new-alpha.example:7850',
  serverIdentity: null,
  updatedAt: '2026-07-18T13:00:00.000Z',
})

const duplicateSettings: StoredProfileSettings = {
  schemaVersion: 2,
  activeProfileId: profileA.id,
  profiles: [profileA, { ...profileB, serverURL: profileA.serverURL }],
  fontScale: 1,
  appearance: 'dark',
}
assertThrows(() => normalizeStoredProfileSettings(duplicateSettings), /already uses/)

const duplicateIdentityProfiles: StoredServerProfile[] = [profileA, { ...profileB, serverIdentity: profileA.serverIdentity }]
assertThrows(() => normalizeStoredProfileSettings({
  ...duplicateSettings,
  profiles: duplicateIdentityProfiles,
}), /already belongs/)

assertEqual(hubProxyRemoteId('http://h:7850/api/remote/abc/'), 'abc')
assertEqual(hubProxyRemoteId('http://h:7850'), null)

const hubURL = 'http://nvmac.tail46daa8.ts.net:7850'
const hubProfile = { id: 'hub', serverURL: hubURL }
const savedRemote = { id: 'remote-aaa', serverURL: `${hubURL}/api/remote/aaa` }
const staleRemote = { id: 'remote-zzz', serverURL: `${hubURL}/api/remote/zzz` }
const otherHubRemote = { id: 'other-hub-remote', serverURL: 'http://other.example:7850/api/remote/aaa' }
const registered = [{ name: 'osmo', proxy_path: '/api/remote/aaa' }, { name: 'lab', proxy_path: '/api/remote/bbb' }]
// Creates the missing remote, removes the unregistered proxied profile of this
// hub, and leaves the hub itself and another hub's proxied profile alone.
assertEqual(reconcileHubProfiles([hubProfile, savedRemote, staleRemote, otherHubRemote], hubURL, registered), {
  create: [{ name: 'lab', serverURL: `${hubURL}/api/remote/bbb` }],
  removeIds: ['remote-zzz'],
})
// A trailing slash or uppercase host on the hub URL still matches saved profiles.
assertEqual(reconcileHubProfiles([hubProfile, savedRemote], 'NVMAC.tail46daa8.ts.net:7850/', [registered[0]]), { create: [], removeIds: [] })
assertEqual(reconcileHubProfiles([hubProfile, savedRemote], hubURL, [registered[0]]), { create: [], removeIds: [] })

// Remotes take the registry's order in the places they already hold; the hub and other profiles stay put.
assertEqual(
  hubRemoteProfileOrder([hubProfile, savedRemote, otherHubRemote, { id: 'remote-bbb', serverURL: `${hubURL}/api/remote/bbb` }], hubURL, [registered[1], registered[0]]),
  ['hub', 'remote-bbb', 'other-hub-remote', 'remote-aaa'],
)
assertEqual(hubRemoteProfileOrder([hubProfile, savedRemote], hubURL, registered), null)

console.log('server profile regressions passed')
