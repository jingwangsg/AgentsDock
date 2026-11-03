import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { ServerProfilesManager, type ServerProfilesManagerProps } from '../src/components/ServerProfiles'
import type { ServerProfileListItem } from '../src/lib/server-profile-ui'

const profile = (id: string, serverUrl: string, extra: Partial<ServerProfileListItem> = {}): ServerProfileListItem => ({
  id, name: id, serverUrl, serverIdentity: 'server-hub', hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0, ...extra,
})
const hub = profile('hub', 'http://100.81.112.90:7850')
const remote = profile('r1', 'http://100.81.112.90:7850/api/remote/r1', { name: 'gpu box', serverIdentity: 'server-r1', sshHost: 'user@host' })

async function render(props: Partial<ServerProfilesManagerProps>) {
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<ServerProfilesManager
      profiles={[hub, remote]}
      activeProfileId="hub"
      onSwitchProfile={() => true}
      onTestConnection={async () => { throw new Error('no connection test for a second address') }}
      onUpdateProfile={() => undefined}
      onReorderProfiles={() => undefined}
      onRemoveProfile={() => undefined}
      onUpdateCli={async () => ''}
      {...props}
    />)
  })
  return tree
}
const texts = (root: ReactTestInstance) => root.findAll(node => (node.type as unknown) === 'Text').flatMap(node => node.children.filter(child => typeof child === 'string'))
const button = (root: ReactTestInstance, label: string) => root.find(node => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label)
const field = (root: ReactTestInstance, testID: string) => root.findAll(node => (node.type as unknown) === 'TextInput' && node.props.testID === testID)

test('a second address is saved without a connection test, and only a directly addressed server has one', async () => {
  const updates: unknown[] = []
  const tree = await render({ onUpdateProfile: (profileId, patch) => { updates.push({ profileId, patch }) } })
  const root = tree.root

  await act(async () => { button(root, 'Edit gpu box').props.onPress() })
  assert.equal(field(root, 'server-profile-second-url').length, 0, 'a hub remote goes through its hub\'s second address')
  await act(async () => { button(root, 'Close server editor').props.onPress() })

  await act(async () => { button(root, 'Edit hub').props.onPress() })
  await act(async () => { field(root, 'server-profile-second-url')[0].props.onChangeText('192.168.0.101:7850') })
  await act(async () => { button(root, 'Save').props.onPress() })
  assert.deepEqual(updates, [{ profileId: 'hub', patch: { secondServerUrl: 'http://192.168.0.101:7850' } }], 'it proves itself before any token goes there, so no test is asked for')
})

test('a hub remote whose hub profile is gone has no second address field either', async () => {
  const tree = await render({ profiles: [remote], activeProfileId: 'r1' })
  await act(async () => { button(tree.root, 'Edit gpu box').props.onPress() })
  assert.equal(field(tree.root, 'server-profile-second-url').length, 0)
})

test('the server list says which address the connection uses, and a cleared second address is removed', async () => {
  const updates: unknown[] = []
  const tree = await render({
    profiles: [{ ...hub, secondServerUrl: 'http://192.168.0.101:7850', secondAddressInUse: true }, remote],
    onUpdateProfile: (profileId, patch) => { updates.push({ profileId, patch }) },
  })
  const root = tree.root
  assert.ok(texts(root).includes('Second: http://192.168.0.101:7850 · in use'))

  await act(async () => { button(root, 'Edit hub').props.onPress() })
  assert.equal(field(root, 'server-profile-second-url')[0].props.value, 'http://192.168.0.101:7850')
  await act(async () => { field(root, 'server-profile-second-url')[0].props.onChangeText(' ') })
  await act(async () => { button(root, 'Save').props.onPress() })
  assert.deepEqual(updates, [{ profileId: 'hub', patch: { secondServerUrl: null } }])
})
