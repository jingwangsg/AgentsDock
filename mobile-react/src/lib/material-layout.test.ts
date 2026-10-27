import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alertButtonLayout, dropdownMenuPosition } from './material-layout'

// Anchors, windows and menus measured on Android build 78 (411.4 × 891.4 dp screen; the visible
// area excludes 28 dp of status bar and 24 dp of navigation bar). Expected positions are where
// Android drew the menu, ±0.5 dp.
const window = { width: 411.4, height: 839.4 }
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) <= 0.5, `${actual} vs ${expected}`)

test('a menu opens below its anchor, aligned to the anchor start, when it fits', () => {
  // Server switcher: the selector spans the sidebar width.
  const position = dropdownMenuPosition({ x: 9.9, y: 120.4, width: 391.2, height: 48 }, window, { width: 123, height: 114.3 })
  near(position.x, 9.9)
  near(position.y, 168.4)
})

test('a tall chat menu centers on its trailing-edge anchor', () => {
  // Chat row: a 0 × 1 anchor at the row's bottom-right corner; the 10-item menu fits neither below nor above.
  const position = dropdownMenuPosition({ x: 405.3, y: 366.7, width: 0, height: 0.4 }, window, { width: 123, height: 498.7 })
  near(position.x, 282.3)
  near(position.y, 117.3)
})

test('a menu that fits nowhere next to a low anchor sits 48 dp above the visible bottom', () => {
  // Quick messages in the composer toolbar.
  const position = dropdownMenuPosition({ x: 243.4, y: 812.9, width: 43.8, height: 43.8 }, window, { width: 179.4, height: 160 })
  near(position.x, 108.2)
  near(position.y, 631.4)
})

test('up to three alert buttons follow RN Android: neutral, negative, positive', () => {
  const cancel = { text: 'Cancel', style: 'cancel' as const }
  const rename = { text: 'Rename' }
  const remove = { text: 'Delete', style: 'destructive' as const }
  assert.deepEqual(alertButtonLayout([cancel, rename, remove]).row, { neutral: cancel, negative: rename, positive: remove })
  assert.deepEqual(alertButtonLayout([cancel, remove]).row, { neutral: undefined, negative: cancel, positive: remove })
  // Stacked, AppCompat lists positive first.
  assert.deepEqual(alertButtonLayout([cancel, rename, remove]).stacked, [remove, rename, cancel])
})

test('more than three alert buttons stack in reverse order with Cancel last (Android would drop them)', () => {
  const buttons = [{ text: 'Reference another chat' }, { text: 'Photo Library' }, { text: 'Files' }, { text: 'Reference a server (@@)' }, { text: 'Cancel', style: 'cancel' as const }]
  const layout = alertButtonLayout(buttons)
  assert.equal(layout.row, null)
  assert.deepEqual(layout.stacked.map(button => button.text), ['Reference a server (@@)', 'Files', 'Photo Library', 'Reference another chat', 'Cancel'])
})
