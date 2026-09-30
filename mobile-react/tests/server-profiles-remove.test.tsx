import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { Alert } from './component-mocks/react-native'
import { ServerProfilesManager } from '../src/components/ServerProfiles'
import type { ServerProfileListItem } from '../src/lib/server-profile-ui'

const profile = (id: string, serverUrl: string): ServerProfileListItem => ({
  id, name: id, serverUrl, serverIdentity: null, hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0,
})

test('the active hub remote is removed from its row menu; the store switches to the hub first', async () => {
  const removed: string[] = []
  let tree: ReturnType<typeof create> | null = null
  await act(async () => {
    tree = create(<ServerProfilesManager
      profiles={[profile('hub', 'http://hub.test:7850'), profile('r1', 'http://hub.test:7850/api/remote/r1')]}
      activeProfileId="r1"
      onSwitchProfile={() => true}
      onTestConnection={async () => { throw new Error('unused') }}
      onUpdateProfile={() => undefined}
      onReorderProfiles={() => undefined}
      onRemoveProfile={profileId => { removed.push(profileId) }}
      onRedeployRemote={async () => ({ redeployed: true, running: 0 })}
      onUpdateCli={async () => ''}
    />)
  })
  Alert.__reset()

  await act(async () => { tree!.root.findByProps({ label: 'More actions for r1' }).props.onPress() })
  await act(async () => { Alert.__calls.at(-1)!.buttons!.find(button => button.text === 'Remove')!.onPress!() })
  assert.match(Alert.__calls.at(-1)!.message ?? '', /switches to the hub first/)
  await act(async () => { Alert.__calls.at(-1)!.buttons!.find(button => button.text === 'Remove server')!.onPress!() })

  assert.deepEqual(removed, ['r1'])
  await act(async () => { tree!.unmount() })
})
