import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import React from 'react'
import { act, create, type ReactTestInstance } from 'react-test-renderer'
import { showAlertDialog } from '../src/components/material/AlertDialog'
import { DateTimePicker } from '../src/components/material/DateTimePickerDialog.ios'
import { showDropdownMenu } from '../src/components/material/DropdownMenu'
import { MaterialOverlayHost } from '../src/components/material/MaterialOverlay'
import { __setWindowSize } from './component-mocks/react-native'

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

test('alert buttons scroll in their own panel that gives up height before the message, as AppCompat does', async () => {
  await renderHost()
  await act(async () => {
    showAlertDialog('Add', undefined, ['Reference a server (@@)', 'Files', 'Photos', 'Reference another chat'].map(text => ({ text })).concat({ text: 'Cancel', style: 'cancel' } as never))
  })
  const panels = tree!.root.findAll(node => node.type === 'ScrollView')
  const flat = (style: unknown) => Object.assign({}, ...[style].flat(3).filter(Boolean)) as Record<string, number>
  const [message, buttons] = panels.map(panel => flat(panel.props.style))
  assert.equal(panels.length, 2)
  assert.ok(panels[1].findAll(node => node.props.accessibilityLabel === 'Cancel').length === 1, 'every button, Cancel included, is inside the scrolling panel')
  assert.ok(buttons.flexShrink > 100 * message.flexShrink, 'the buttons shrink first')
  // ButtonBarLayout's minimum when stacked: padding, the first button, the next one's top padding and a 16 pt peek.
  assert.equal(buttons.minHeight, 5 + 54 + 10 + 16)
  await act(async () => { tree!.root.findByProps({ accessibilityLabel: 'Cancel' }).props.onPress() })
  assert.equal(overlayShown(), false)
})

test('the date and time dialogs are drawn smaller to fit a window shorter than the card, and unchanged otherwise', async () => {
  const visibleCard = async (mode: 'date' | 'time', window: { width: number; height: number }) => {
    __setWindowSize(window)
    await renderHost(<DateTimePicker value={new Date(Date.UTC(2026, 9, 27))} mode={mode} accentColor="#74ade8" positiveButton={{ label: 'Set' }} negativeButton={{ label: 'Cancel' }} />)
    const card = Object.assign({}, ...[modals()[0].props.style].flat(3).filter(Boolean)) as { height: number; transform?: Array<{ scale: number }> }
    const scale = card.transform?.[0].scale ?? 1
    await act(async () => { tree!.root.findByProps({ accessibilityLabel: 'Cancel' }).props.onPress() })
    await act(async () => { tree!.unmount() })
    tree = null
    return { scale, height: card.height * scale }
  }
  try {
    for (const mode of ['date', 'time'] as const) {
      // An iPad app window resized to 788 × 486 pt (iPadOS windowed apps), and a phone in landscape.
      for (const window of [{ width: 788, height: 486 }, { width: 874, height: 402 }]) {
        const shown = await visibleCard(mode, window)
        assert.ok(shown.scale < 1, `${mode} ${window.height}`)
        assert.ok(shown.height <= window.height, `${mode} card, with Set and Cancel at its bottom, fits ${window.height} pt`)
      }
      // Portrait phone and full-screen iPad: drawn as before, with no transform.
      for (const window of [{ width: 402, height: 874 }, { width: 1032, height: 1376 }]) {
        assert.deepEqual(await visibleCard(mode, window), { scale: 1, height: mode === 'date' ? 568 : 516 })
      }
    }
  } finally {
    __setWindowSize({ width: 390, height: 844 })
  }
})
