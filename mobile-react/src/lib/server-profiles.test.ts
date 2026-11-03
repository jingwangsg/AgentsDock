import type { StoredProfileSettings, StoredServerProfile } from '../types'
import {
  applyStoredServerProfileUpdate,
  assertUniqueServerProfile,
  createStoredServerProfile,
  findDuplicateProfileByIdentity,
  findDuplicateProfileByURL,
  hubOrphanCandidates,
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
// A hidden hub remote stays hidden across a restart; profiles saved before the flag existed are visible.
const hiddenSettings = { ...migrated.settings, profiles: [{ ...migrated.settings.profiles[0], hidden: true }] }
assertEqual(normalizeStoredProfileSettings(hiddenSettings).profiles[0].hidden, true)
assertEqual('hidden' in normalizeStoredProfileSettings(migrated.settings).profiles[0], false)

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

// The hub the other profiles are proxied through reads as "local" unless it was named by hand; other names stay.
const namesWithHubNamed = (name: string) => normalizeStoredProfileSettings({
  ...duplicateSettings,
  activeProfileId: 'hub',
  profiles: [
    { ...profileA, id: 'hub', name, serverURL: 'http://nvmac.tail46daa8.ts.net:7850', serverIdentity: 'server-hub' },
    { ...profileB, id: 'osmo', name: 'osmo_dev_l40', serverURL: 'http://nvmac.tail46daa8.ts.net:7850/api/remote/abc', serverIdentity: 'server-osmo' },
    profileB,
  ],
}).profiles.map(profile => profile.name)
assertEqual(namesWithHubNamed('nvmac.tail46daa8.ts.net'), ['local', 'osmo_dev_l40', 'beta.example'])
assertEqual(namesWithHubNamed('server-hub'), ['local', 'osmo_dev_l40', 'beta.example'])
assertEqual(namesWithHubNamed('Home Mac'), ['Home Mac', 'osmo_dev_l40', 'beta.example'])

assertEqual(hubProxyRemoteId('http://h:7850/api/remote/abc/'), 'abc')
assertEqual(hubProxyRemoteId('http://h:7850'), null)

const hubURL = 'http://nvmac.tail46daa8.ts.net:7850'
const hubProfile = { id: 'hub', serverURL: hubURL }
const savedRemote = { id: 'remote-aaa', name: 'osmo', serverURL: `${hubURL}/api/remote/aaa`, sshHost: 'osmo_9000' }
const staleRemote = { id: 'remote-zzz', serverURL: `${hubURL}/api/remote/zzz` }
const otherHubRemote = { id: 'other-hub-remote', serverURL: 'http://other.example:7850/api/remote/aaa' }
const registered = [{ name: 'osmo', proxy_path: '/api/remote/aaa', ssh_host: 'osmo_9000' }, { name: 'lab', proxy_path: '/api/remote/bbb', ssh_host: 'lab' }]
// Creates the missing remote, removes the unregistered proxied profile of this
// hub, and leaves the hub itself and another hub's proxied profile alone.
assertEqual(reconcileHubProfiles([hubProfile, savedRemote, staleRemote, otherHubRemote], hubURL, registered), {
  create: [{ name: 'lab', serverURL: `${hubURL}/api/remote/bbb`, sshHost: 'lab' }],
  update: [],
  removeIds: ['remote-zzz'],
})
// A trailing slash or uppercase host on the hub URL still matches saved profiles.
assertEqual(reconcileHubProfiles([hubProfile, savedRemote], 'NVMAC.tail46daa8.ts.net:7850/', [registered[0]]), { create: [], update: [], removeIds: [] })
assertEqual(reconcileHubProfiles([hubProfile, savedRemote], hubURL, [registered[0]]), { create: [], update: [], removeIds: [] })
// A remote moved on the hub (same id, new SSH host), or saved before profiles kept the host, follows the hub.
assertEqual(reconcileHubProfiles([hubProfile, savedRemote], hubURL, [{ ...registered[0], ssh_host: 'osmo@new-host' }]),
  { create: [], update: [{ id: 'remote-aaa', name: 'osmo', sshHost: 'osmo@new-host', hidden: false }], removeIds: [] })
assertEqual(reconcileHubProfiles([hubProfile, { id: 'remote-aaa', name: 'osmo', serverURL: savedRemote.serverURL }], hubURL, [registered[0]]),
  { create: [], update: [{ id: 'remote-aaa', name: 'osmo', sshHost: 'osmo_9000', hidden: false }], removeIds: [] })
// The hub keeps a remote's name: a rename on another device (or one saved here before the hub kept names) follows
// it, even to a name another remote has.
assertEqual(reconcileHubProfiles([hubProfile, { ...savedRemote, name: 'osmo_dev_l40' }], hubURL, [registered[0]]),
  { create: [], update: [{ id: 'remote-aaa', name: 'osmo', sshHost: 'osmo_9000', hidden: false }], removeIds: [] })
assertEqual(reconcileHubProfiles([hubProfile, savedRemote], hubURL, [{ ...registered[0], name: 'lab' }, registered[1]]).update,
  [{ id: 'remote-aaa', name: 'lab', sshHost: 'osmo_9000', hidden: false }])
// A remote hidden or shown on the hub follows it; a new remote comes in hidden. A hub that predates the flag
// lists every remote as visible.
assertEqual(reconcileHubProfiles([hubProfile, savedRemote], hubURL, [{ ...registered[0], hidden: true }, { ...registered[1], hidden: true }]), {
  create: [{ name: 'lab', serverURL: `${hubURL}/api/remote/bbb`, sshHost: 'lab', hidden: true }],
  update: [{ id: 'remote-aaa', name: 'osmo', sshHost: 'osmo_9000', hidden: true }],
  removeIds: [],
})
assertEqual(reconcileHubProfiles([hubProfile, { ...savedRemote, hidden: true }], hubURL, [{ ...registered[0], hidden: false }]),
  { create: [], update: [{ id: 'remote-aaa', name: 'osmo', sshHost: 'osmo_9000', hidden: false }], removeIds: [] })
assertEqual(reconcileHubProfiles([hubProfile, { ...savedRemote, hidden: true }], hubURL, [registered[0]]),
  { create: [], update: [{ id: 'remote-aaa', name: 'osmo', sshHost: 'osmo_9000', hidden: false }], removeIds: [] })
assertEqual(reconcileHubProfiles([hubProfile, { ...savedRemote, hidden: true }], hubURL, [{ ...registered[0], hidden: true }]),
  { create: [], update: [], removeIds: [] })
assertEqual(createStoredServerProfile({ serverURL: `${hubURL}/api/remote/bbb`, hidden: true }, 'remote-bbb', timestamp).hidden, true)
assertEqual('hidden' in createStoredServerProfile({ serverURL: `${hubURL}/api/remote/bbb`, hidden: false }, 'remote-bbb', timestamp), false)

// The hub moved (Tailscale to LAN) under a build that keyed remotes by URL: its remotes were saved again under the
// new address. Only orphans the caller adopted (they carry this hub's token) count; each remote keeps one profile,
// the one ranked first, else the one under the hub's URL, and moves under the hub's URL.
const oldHubURL = 'http://100.64.0.7:7850'
const oldRemote = { id: 'old-aaa', name: 'osmo', serverURL: `${oldHubURL}/api/remote/aaa`, sshHost: 'osmo_9000' }
const oldLab = { id: 'old-bbb', name: 'lab', serverURL: `${oldHubURL}/api/remote/bbb`, sshHost: 'lab' }
const oldGone = { id: 'old-zzz', name: 'gone', serverURL: `${oldHubURL}/api/remote/zzz`, sshHost: 'gone' }
const newLab = { id: 'new-bbb', name: 'lab', serverURL: `${hubURL}/api/remote/bbb`, sshHost: 'lab' }
assertEqual(hubOrphanCandidates([hubProfile, oldRemote, oldLab, oldGone, newLab, otherHubRemote], hubURL, registered).map(profile => profile.id),
  ['old-aaa', 'old-bbb', 'other-hub-remote'])
assertEqual(hubOrphanCandidates([hubProfile, { id: 'other-hub', serverURL: 'http://other.example:7850' }, otherHubRemote], hubURL, registered), [])
const adopted = new Set(['old-aaa', 'old-bbb'])
assertEqual(reconcileHubProfiles([hubProfile, oldRemote, oldLab, oldGone, newLab, otherHubRemote], hubURL, registered, adopted, id => id === 'old-bbb' ? 3 : 0), {
  create: [],
  update: [
    { id: 'old-aaa', name: 'osmo', sshHost: 'osmo_9000', hidden: false, serverURL: `${hubURL}/api/remote/aaa` },
    { id: 'old-bbb', name: 'lab', sshHost: 'lab', hidden: false, serverURL: `${hubURL}/api/remote/bbb` },
  ],
  removeIds: ['new-bbb'],
})
// Without local state on either side the one under the hub's URL stays; the active one (ranked first) always does.
assertEqual(reconcileHubProfiles([hubProfile, oldLab, newLab], hubURL, [registered[1]], adopted).removeIds, ['old-bbb'])
assertEqual(reconcileHubProfiles([hubProfile, oldLab, newLab], hubURL, [registered[1]], adopted, id => id === 'old-bbb' ? Infinity : 5), {
  create: [], update: [{ id: 'old-bbb', name: 'lab', sshHost: 'lab', hidden: false, serverURL: `${hubURL}/api/remote/bbb` }], removeIds: ['new-bbb'],
})
// An orphan the caller did not adopt (another hub's token) and one with an id the hub does not list stay as they are.
assertEqual(reconcileHubProfiles([hubProfile, oldLab, oldGone, newLab], hubURL, [registered[1]]), { create: [], update: [], removeIds: [] })

// A second address is stored normalized, and not at all when blank, the same as the primary, or on a hub remote
// (its hub's applies).
const withSecond = (serverURL: string, secondServerURL: string) => normalizeStoredProfileSettings({
  ...duplicateSettings, activeProfileId: 'a', profiles: [{ ...profileA, id: 'a', serverURL, secondServerURL }],
}).profiles[0].secondServerURL
assertEqual(withSecond('http://100.81.112.90:7850', '192.168.0.101'), 'http://192.168.0.101:7850')
assertEqual(withSecond('http://100.81.112.90:7850', ' '), undefined)
assertEqual(withSecond('http://100.81.112.90:7850', '100.81.112.90:7850'), undefined)
assertEqual(withSecond('http://100.81.112.90:7850/api/remote/aaa', '192.168.0.101'), undefined)
const savedHub = createStoredServerProfile({ serverURL: 'http://100.81.112.90:7850', serverIdentity: 'server-hub' }, 'hub', timestamp)
assertEqual(applyStoredServerProfileUpdate(savedHub, { secondServerURL: '192.168.0.101' }, timestamp).secondServerURL, 'http://192.168.0.101:7850')
assertEqual('secondServerURL' in applyStoredServerProfileUpdate({ ...savedHub, secondServerURL: 'http://192.168.0.101:7850' }, { secondServerURL: null }, timestamp), false)
assertEqual(applyStoredServerProfileUpdate({ ...savedHub, secondServerURL: 'http://192.168.0.101:7850' }, { name: 'Mac' }, timestamp).secondServerURL, 'http://192.168.0.101:7850')
// The learned proof capability stays with the pinned server, and goes when the identity is reset for a replacement.
assertEqual(applyStoredServerProfileUpdate({ ...savedHub, connectProof: true }, { serverURL: 'http://100.81.112.91:7850' }, timestamp).connectProof, true)
assertEqual('connectProof' in applyStoredServerProfileUpdate({ ...savedHub, connectProof: true }, { resetServerIdentity: true }, timestamp), false)

// Remotes take the registry's order in the places they already hold; the hub and other profiles stay put.
assertEqual(
  hubRemoteProfileOrder([hubProfile, savedRemote, otherHubRemote, { id: 'remote-bbb', serverURL: `${hubURL}/api/remote/bbb` }], hubURL, [registered[1], registered[0]]),
  ['hub', 'remote-bbb', 'other-hub-remote', 'remote-aaa'],
)
assertEqual(hubRemoteProfileOrder([hubProfile, savedRemote], hubURL, registered), null)

console.log('server profile regressions passed')
