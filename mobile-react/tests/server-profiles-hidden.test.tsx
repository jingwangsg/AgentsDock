import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { ServerProfileSelector, ServerProfilesManager } from '../src/components/ServerProfiles'
import type { ServerProfileListItem } from '../src/lib/server-profile-ui'

const profile = (id: string, serverUrl: string, extra: Partial<ServerProfileListItem> = {}): ServerProfileListItem => ({
  id, name: id, serverUrl, serverIdentity: null, hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0, ...extra,
})
const hub = profile('hub', 'http://hub.test:7850')
const hidden = profile('r1', 'http://hub.test:7850/api/remote/r1', { hidden: true })
const shown = profile('r2', 'http://hub.test:7850/api/remote/r2')

const texts = (root: ReactTestInstance) => root.findAll(node => (node.type as unknown) === 'Text').flatMap(node => node.children.filter(child => typeof child === 'string'))
const button = (root: ReactTestInstance, label: string) => root.findAll(node => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label)

async function renderSelector(activeProfileId: string) {
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<ServerProfileSelector profiles={[hub, hidden, shown]} activeProfileId={activeProfileId} onSelectProfile={() => true} onManageServers={() => undefined} />)
  })
  const menu = tree.root.find(node => Array.isArray(node.props.actions))
  const listed = (menu.props.actions[0].subactions as Array<{ id: string; state: string }>).map(action => `${action.id}:${action.state}`)
  await act(async () => { tree.unmount() })
  return listed
}

test('the server picker leaves a hidden remote out, unless it is the server in use', async () => {
  assert.deepEqual(await renderSelector('hub'), ['profile:hub:on', 'profile:r2:off'])
  assert.deepEqual(await renderSelector('r1'), ['profile:hub:off', 'profile:r1:on', 'profile:r2:off'])
})

test('Manage Servers lists a hidden remote, marked, and its eye toggle asks the hub to show or hide it', async () => {
  const requests: Array<{ profileId: string; hidden: boolean }> = []
  let fail: Error | null = null
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<ServerProfilesManager
      profiles={[hub, hidden, shown]}
      activeProfileId="hub"
      onSwitchProfile={() => true}
      onTestConnection={async () => { throw new Error('unused') }}
      onUpdateProfile={() => undefined}
      onReorderProfiles={() => undefined}
      onRemoveProfile={() => undefined}
      onRedeployRemote={async () => ({ redeployed: true, running: 0 })}
      onMoveRemote={async () => undefined}
      onSetRemoteHidden={async (profileId, value) => {
        requests.push({ profileId, hidden: value })
        if (fail) throw fail
      }}
      onUpdateCli={async () => ''}
    />)
  })
  const root = tree.root
  assert.equal(texts(root).filter(text => text === 'Hidden').length, 1)
  assert.ok(texts(root).includes('r1'))
  // The hub itself is never hidden, so its row has no toggle.
  assert.equal(button(root, 'Hide hub from the server switcher').length, 0)

  await act(async () => { button(root, 'Show r1 in the server switcher')[0].props.onPress() })
  await act(async () => { button(root, 'Hide r2 from the server switcher')[0].props.onPress() })
  assert.deepEqual(requests, [{ profileId: 'r1', hidden: false }, { profileId: 'r2', hidden: true }])

  // A refused request stays on the row.
  fail = new Error('The hub could not save the change.')
  await act(async () => { button(root, 'Hide r2 from the server switcher')[0].props.onPress() })
  assert.ok(texts(root).includes('The hub could not save the change.'))
  await act(async () => { tree.unmount() })
})
