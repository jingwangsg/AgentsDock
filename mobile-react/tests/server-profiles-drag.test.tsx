import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { lists } from 'react-native-draggable-flatlist'
import { ServerProfilesManager } from '../src/components/ServerProfiles'
import type { ServerProfileListItem } from '../src/lib/server-profile-ui'

const profile = (id: string, serverUrl: string): ServerProfileListItem => ({
  id, name: id, serverUrl, serverIdentity: null, hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0,
})

test('servers below the pinned hub are dragged into a new order', async () => {
  const orders: string[][] = []
  const [hub, r1, r2] = [profile('hub', 'http://hub.test:7850'), profile('r1', 'http://hub.test:7850/api/remote/r1'), profile('r2', 'http://hub.test:7850/api/remote/r2')]
  let tree: ReturnType<typeof create> | null = null
  await act(async () => {
    tree = create(<ServerProfilesManager
      profiles={[hub, r1, r2]}
      activeProfileId="hub"
      onSwitchProfile={() => true}
      onTestConnection={async () => { throw new Error('unused') }}
      onUpdateProfile={() => undefined}
      onReorderProfiles={order => { orders.push(order) }}
      onRemoveProfile={() => undefined}
      onRedeployRemote={async () => ({ redeployed: true, running: 0 })}
      onUpdateCli={async () => ''}
    />)
  })
  assert.equal(tree!.root.findAllByProps({ accessibilityLabel: 'Drag hub to reorder' }).length, 0, 'the hub is pinned and has no grip')
  assert.equal(tree!.root.findAllByProps({ accessibilityLabel: 'Drag r1 to reorder' }).length, 1)
  const list = lists.at(-1)!
  assert.deepEqual(list.data.map((item: ServerProfileListItem) => item.id), ['r1', 'r2'], 'only the remotes are in the draggable list')

  await act(async () => { list.onDragEnd({ data: [r2, r1], from: 1, to: 0 }) })

  assert.deepEqual(orders, [['hub', 'r2', 'r1']], 'the saved order keeps the hub first')
  await act(async () => { tree!.unmount() })
})
