import {
  buildUpdateServerProfileInput,
  editServerProfileDraft,
  findProfileByIdentity,
  initialServerProfileDraft,
  profileHostSubtitle,
  displayServerProfileName,
  serverProfileHost,
  requiresIdentityResetConfirmation,
  unreadCountLabel,
  type ServerProfileListItem,
} from './server-profile-ui'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

const alpha: ServerProfileListItem = {
  id: 'alpha',
  name: 'Alpha',
  serverUrl: 'https://alpha.example:7850',
  serverIdentity: 'server-alpha',
  hasAccessToken: true,
  serverSetupComplete: true,
  connectionState: 'online',
  cachedUnreadCount: 0,
}
const beta: ServerProfileListItem = {
  ...alpha,
  id: 'beta',
  name: 'Beta',
  serverUrl: 'https://beta.example:7850',
  serverIdentity: 'server-beta',
}

assertEqual(
  initialServerProfileDraft('edit-active', [alpha, beta], 'alpha'),
  editServerProfileDraft(alpha),
  'first-run Configure must open the active placeholder directly in the editor',
)
assertEqual(
  initialServerProfileDraft('edit-active', [], null),
  null,
  'first-run Configure has nothing to edit if profile recovery yields no active row',
)
assertEqual(initialServerProfileDraft('manage', [alpha], 'alpha'), null, 'ordinary server management must start at the list')

// The first-launch placeholder (127.0.0.1, not yet configured) opens with blank
// name/address so the hub placeholders show, and a blank name derives from the
// entered hub address instead of staying "127.0.0.1".
const placeholder: ServerProfileListItem = { ...alpha, id: 'placeholder', name: '127.0.0.1', serverUrl: 'http://127.0.0.1:7850', serverIdentity: null, hasAccessToken: false, serverSetupComplete: false }
const placeholderDraft = editServerProfileDraft(placeholder)
assertEqual([placeholderDraft.name, placeholderDraft.serverUrl], ['', ''], 'the unconfigured placeholder must open with blank name and address')
assertEqual(
  buildUpdateServerProfileInput(placeholder, { ...placeholderDraft, serverUrl: 'nvmac.tail46daa8.ts.net', accessToken: 'hub-token' }, 'hub-identity'),
  { name: 'nvmac.tail46daa8.ts.net', serverUrl: 'http://nvmac.tail46daa8.ts.net:7850', accessToken: 'hub-token', serverIdentity: 'hub-identity' },
  'a blank name must fall back to the hub host name',
)

const unchanged = editServerProfileDraft(alpha)
assertEqual(buildUpdateServerProfileInput(alpha, unchanged), {}, 'blank edit token must preserve the saved credential')

const cleared = { ...unchanged, clearAccessToken: true }
assertEqual(buildUpdateServerProfileInput(alpha, cleared), { accessToken: null }, 'token removal must be explicit')
assertEqual(buildUpdateServerProfileInput(alpha, cleared, 'server-alpha-tested'), { accessToken: null, serverIdentity: 'server-alpha-tested' }, 'a connection update must carry the identity from its successful test')

const replaced = { ...unchanged, accessToken: 'new-private-token' }
assertEqual(buildUpdateServerProfileInput(alpha, replaced), { accessToken: 'new-private-token' }, 'nonblank token must replace the saved credential')
assertEqual(buildUpdateServerProfileInput(alpha, unchanged, 'server-alpha-tested'), {}, 'a metadata-free edit must not forward a tested identity by itself')

assert(findProfileByIdentity([alpha, beta], 'server-beta')?.id === 'beta', 'canonical identity must find an existing profile')
assert(findProfileByIdentity([alpha, beta], 'server-beta', 'beta') === null, 'editing a profile must not duplicate-match itself')

assert(profileHostSubtitle(alpha) === 'alpha.example:7850', 'selector must show a distinct server host')
assert(profileHostSubtitle({ ...alpha, name: 'alpha.example:7850' }) === null, 'selector must not repeat a host used as the profile name')
const hub = { ...alpha, name: '127.0.0.1', serverUrl: 'http://127.0.0.1:7850', serverIdentity: null }
assert(displayServerProfileName(hub) === 'local', 'a loopback hub saved under its address reads as local')
assert(profileHostSubtitle(hub) === null, 'Local must not be repeated as a subtitle')
assert(displayServerProfileName({ ...hub, name: 'Home Mac' }) === 'Home Mac', 'a user-chosen hub name is kept')
assert(profileHostSubtitle({ ...hub, name: 'Home Mac' }) === 'Local', 'a named hub shows Local as its host')
const hubRemote = { ...alpha, name: 'gpu box', serverUrl: 'http://hub.test:7850/api/remote/r1', sshHost: 'user@gpu-box' }
assert(profileHostSubtitle(hubRemote) === 'user@gpu-box', 'a hub remote shows its SSH host')
assert(profileHostSubtitle({ ...hubRemote, sshHost: undefined }) === null, 'a hub remote never shows the proxy address')
assert(serverProfileHost('http://nvmac.tail46daa8.ts.net:7850') === 'nvmac.tail46daa8.ts.net:7850', 'remote hosts keep their address')
assert(unreadCountLabel(100) === '99+', 'unread badge must stay compact')
assert(requiresIdentityResetConfirmation({ ...alpha, lastConnectionError: 'Server identity changed from server-alpha to server-new.' }), 'identity changes must require confirmation')
assert(requiresIdentityResetConfirmation({ ...alpha, lastConnectionError: 'Server identity mismatch: expected server-alpha, received server-new.' }), 'identity mismatches must allow an explicit reset')

console.log('server profile UI regressions passed')
