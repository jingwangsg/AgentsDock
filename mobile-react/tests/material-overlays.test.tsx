import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { showAlertDialog } from '../src/components/material/AlertDialog'
import { DateTimePicker } from '../src/components/material/DateTimePickerDialog.ios'
import { showDropdownMenu } from '../src/components/material/DropdownMenu'
import { MaterialOverlayHost } from '../src/components/material/MaterialOverlay'

// The iOS app-drawn menus and dialogs, rendered through the overlay host as the app mounts them.
let tree: ReturnType<typeof create> | null = null
const renderHost = async (children?: React.ReactNode) => {
  await act(async () => { tree = create(<><MaterialOverlayHost />{children}</>) })
}
const overlayShown = () => tree!.root.findAll(node => node.type === 'FullWindowOverlay').length > 0
// The menu surface or dialog card: the view VoiceOver is confined to.
const modals = () => tree!.root.findAll(node => typeof node.type === 'string' && node.props.accessibilityViewIsModal === true)
const escape = async (modal: ReactTestInstance) => { await act(async () => { modal.props.onAccessibilityEscape() }) }

afterEach(async () => {
  if (tree) await act(async () => { tree!.unmount() })
  tree = null
})

test('VoiceOver escape closes a dropdown menu without choosing an item, and a submenu before its menu', async () => {
  await renderHost()
  const chosen: string[] = []
  let closed = 0
  await act(async () => {
    showDropdownMenu({
      measureAnchor: report => report({ x: 300, y: 100, width: 44, height: 44 }),
      actions: [{ id: 'rename', title: 'Rename Chat' }, { title: 'Move to Folder', subactions: [{ id: 'folder-a', title: 'Folder A' }] }],
      onAction: id => { chosen.push(id) },
      onClose: () => { closed++ },
    })
  })
  // Open the submenu: the menu and its item report their layout first, as on a device.
  await act(async () => { modals()[0].props.onLayout({ nativeEvent: { layout: { width: 200, height: 112 } } }) })
  const parent = tree!.root.findAll(node => node.props.accessibilityLabel === 'Move to Folder' && typeof node.props.onPress === 'function')[0]
  await act(async () => { parent.props.onLayout({ nativeEvent: { layout: { y: 56, width: 200, height: 48 } } }) })
  await act(async () => { parent.props.onPress() })
  assert.equal(modals().length, 2)

  await escape(modals()[1])
  assert.equal(modals().length, 1, 'escape in the submenu closes only the submenu')
  assert.equal(closed, 0)

  await escape(modals()[0])
  assert.equal(overlayShown(), false)
  assert.equal(closed, 1)
  assert.deepEqual(chosen, [])
})

test('VoiceOver escape dismisses a cancelable alert, as a tap outside does, and leaves a non-cancelable one open', async () => {
  await renderHost()
  let dismissed = 0
  const pressed: string[] = []
  await act(async () => {
    showAlertDialog('Delete chat?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel', onPress: () => { pressed.push('Cancel') } },
      { text: 'Delete', style: 'destructive', onPress: () => { pressed.push('Delete') } },
    ], { cancelable: true, onDismiss: () => { dismissed++ } })
  })
  await escape(modals()[0])
  assert.equal(overlayShown(), false)
  assert.equal(dismissed, 1)
  assert.deepEqual(pressed, [])

  await act(async () => { showAlertDialog('Server updated', 'Restart to finish.', [{ text: 'OK' }]) })
  assert.equal(modals()[0].props.onAccessibilityEscape, undefined, 'a non-cancelable alert has no escape, so VoiceOver keeps it open')
  // The overlay entries outlive the host: close this one for the next test.
  await act(async () => { tree!.root.findByProps({ accessibilityLabel: 'OK' }).props.onPress() })
  assert.equal(overlayShown(), false)
})

test('VoiceOver escape dismisses the date and time dialogs, as a tap outside does', async () => {
  for (const mode of ['date', 'time'] as const) {
    let dismissed = 0
    let changed = 0
    await renderHost(<DateTimePicker
      value={new Date(Date.UTC(2026, 9, 27))}
      mode={mode}
      accentColor="#74ade8"
      positiveButton={{ label: 'Set' }}
      negativeButton={{ label: 'Cancel' }}
      onValueChange={() => { changed++ }}
      onDismiss={() => { dismissed++ }}
    />)
    await escape(modals()[0])
    assert.equal(overlayShown(), false, mode)
    assert.equal(dismissed, 1, mode)
    assert.equal(changed, 0, mode)
    await act(async () => { tree!.unmount() })
    tree = null
  }
})
