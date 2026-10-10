import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { lists } from 'react-native-draggable-flatlist'
import { ServerProfilesManager, type ServerProfilesManagerProps } from '../src/components/ServerProfiles'
import type { ServerProfileListItem } from '../src/lib/server-profile-ui'

const profile = (id: string, serverUrl: string, extra: Partial<ServerProfileListItem> = {}): ServerProfileListItem => ({
  id, name: id, serverUrl, serverIdentity: null, hasAccessToken: true, serverSetupComplete: true, connectionState: 'online', cachedUnreadCount: 0, ...extra,
})
const hub = profile('hub', 'http://hub.test:7850')
const remote = profile('r1', 'http://hub.test:7850/api/remote/r1', { name: 'gpu box', sshHost: 'user@old-host' })

async function render(props: Partial<ServerProfilesManagerProps>) {
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(<ServerProfilesManager
      profiles={[hub, remote]}
      activeProfileId="hub"
      onSwitchProfile={() => true}
      onTestConnection={async () => { throw new Error('unused') }}
      onUpdateProfile={() => undefined}
      onReorderProfiles={() => undefined}
      onRemoveProfile={() => undefined}
      onRedeployRemote={async () => ({ redeployed: true, running: 0 })}
      onMoveRemote={async () => undefined}
      onUpdateCli={async () => ''}
      {...props}
    />)
  })
  return tree
}
const texts = (root: ReactTestInstance) => root.findAll(node => (node.type as unknown) === 'Text').flatMap(node => node.children.filter(child => typeof child === 'string'))
const button = (root: ReactTestInstance, label: string) => root.find(node => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label)
const field = (root: ReactTestInstance, testID: string) => root.findAll(node => (node.type as unknown) === 'TextInput' && node.props.testID === testID)
const type = (root: ReactTestInstance, testID: string, text: string) => act(async () => { field(root, testID)[0].props.onChangeText(text) })
const press = (root: ReactTestInstance, label: string) => act(async () => { button(root, label).props.onPress() })

test('a hub remote is edited as on the desktop: SSH host and install dir move it, no proxy address or token', async () => {
  const moves: unknown[] = []
  const updates: unknown[] = []
  let cancels = 0
  let finishReorder!: () => void
  let failMove!: (error: Error) => void
  const tree = await render({
    onUpdateProfile: (profileId, patch) => { updates.push({ profileId, patch }) },
    onReorderProfiles: () => new Promise<void>(resolve => { finishReorder = resolve }),
    onMoveRemote: (profileId, input, onProgress) => {
      moves.push({ profileId, input })
      onProgress({ phase: 'upload', message: 'Uploading AgentsServer' })
      return new Promise<void>((_resolve, reject) => { failMove = reject })
    },
    onCancelDeploy: () => { cancels += 1 },
  })
  const root = tree.root

  // The row reads as the host the remote runs on; the hub's proxy address never shows.
  assert.ok(texts(root).includes('user@old-host'))
  assert.ok(!texts(root).some(text => text.includes('/api/remote/')))

  await press(root, 'Edit gpu box')
  assert.equal(field(root, 'server-profile-url').length, 0)
  assert.equal(field(root, 'server-profile-token').length, 0)
  assert.equal(root.findAll(node => node.props.accessibilityLabel === 'Test connection').length, 0)
  assert.equal(field(root, 'server-profile-ssh-host')[0].props.value, 'user@old-host')
  assert.equal(field(root, 'server-profile-install-dir')[0].props.value, '')

  // A drag-reorder in flight is not a move: Save does not read "Deploying…" and Cancel cannot reach a hub job.
  await act(async () => { lists.at(-1)!.onDragEnd({ data: [remote] }) })
  assert.equal(root.findAll(node => node.props.accessibilityLabel === 'Deploying…').length, 0)
  assert.equal(button(root, 'Cancel').props.disabled, true)
  await act(async () => { finishReorder() })

  // A new SSH host moves the remote; an unchanged name is not saved.
  await type(root, 'server-profile-ssh-host', 'user@new-host')
  await press(root, 'Save')
  assert.deepEqual(moves, [{ profileId: 'r1', input: { sshHost: 'user@new-host', installDir: undefined } }])
  assert.deepEqual(updates, [])
  assert.ok(texts(root).includes('Uploading AgentsServer'))
  assert.ok(root.findAll(node => node.props.accessibilityLabel === 'Deploying…').length > 0)

  await press(root, 'Cancel')
  assert.equal(cancels, 1)
  // The store rejects a cancelled move; the editor stays open with the hub's message.
  await act(async () => { failMove(new Error('Deployment cancelled.')) })
  assert.ok(texts(root).includes('Deployment cancelled.'))
  assert.equal(field(root, 'server-profile-ssh-host').length, 1)

  // The hub itself keeps its address and token fields.
  await press(root, 'Edit hub')
  assert.equal(field(root, 'server-profile-url').length, 1)
  assert.equal(field(root, 'server-profile-ssh-host').length, 0)
  await act(async () => { tree.unmount() })
})

test('an install directory alone moves the remote without resending its saved host', async () => {
  const moves: unknown[] = []
  const tree = await render({ onMoveRemote: async (profileId, input) => { moves.push({ profileId, input }) } })
  await press(tree.root, 'Edit gpu box')
  await type(tree.root, 'server-profile-install-dir', '/data/agentsdock')
  await press(tree.root, 'Save')
  assert.deepEqual(moves, [{ profileId: 'r1', input: { sshHost: undefined, installDir: '/data/agentsdock' } }])
  await act(async () => { tree.unmount() })
})

test('renaming a hub remote saves only the name; a blank name keeps it; an unknown host does not block it', async () => {
  const moves: unknown[] = []
  const updates: unknown[] = []
  const tree = await render({
    profiles: [hub, { ...remote, sshHost: undefined }],
    activeProfileId: 'r1',
    onUpdateProfile: (profileId, patch) => { updates.push({ profileId, patch }) },
    onMoveRemote: async (profileId, input) => { moves.push({ profileId, input }) },
  })
  const root = tree.root
  await press(root, 'Edit gpu box')
  await type(root, 'server-profile-name', '')
  await press(root, 'Save')
  assert.deepEqual(updates, [])
  await press(root, 'Edit gpu box')
  await type(root, 'server-profile-name', 'gpu box (old)')
  assert.equal(button(root, 'Save').props.disabled, false)
  await press(root, 'Save')
  assert.deepEqual(updates, [{ profileId: 'r1', patch: { name: 'gpu box (old)' } }])
  assert.deepEqual(moves, [])
  await act(async () => { tree.unmount() })
})

test('a remote whose hub is not saved here keeps the address form', async () => {
  const tree = await render({ profiles: [hub, profile('orphan', 'http://gone-hub.test:7850/api/remote/r9')] })
  await press(tree.root, 'Edit orphan')
  assert.equal(field(tree.root, 'server-profile-url').length, 1)
  assert.equal(field(tree.root, 'server-profile-ssh-host').length, 0)
  await act(async () => { tree.unmount() })
})
