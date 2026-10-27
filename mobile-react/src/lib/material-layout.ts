import type { AlertButton } from 'react-native'

// Layout rules of the Android widgets that iOS draws in components/material.

export type Rect = { x: number; y: number; width: number; height: number }
export type Size = { width: number; height: number }

const VERTICAL_MARGIN = 48

/**
 * Compose Material 3's DropdownMenuPositionProvider (material3 1.5.0-alpha17, as @expo/ui's
 * Android MenuView uses it: horizontal margin 0, vertical margin 48). Like on
 * Android, `anchor` is in window coordinates while `window` is the size of the visible area
 * (system bars and keyboard excluded), so the bottom checks stop short of the screen bottom.
 */
export function dropdownMenuPosition(anchor: Rect, window: Size, menu: Size): { x: number; y: number } {
  const windowX = (alignRight: boolean) => menu.width >= window.width
    ? (window.width - menu.width) / 2
    : alignRight ? window.width - menu.width : 0
  const xCandidates = [
    anchor.x,
    anchor.x + anchor.width - menu.width,
    windowX(anchor.x + anchor.width / 2 >= window.width / 2),
  ]
  const x = xCandidates.find((value, index) => index === xCandidates.length - 1 || (value >= 0 && value + menu.width <= window.width))!
  const windowY = (alignBottom: boolean) => {
    if (menu.height >= window.height - 2 * VERTICAL_MARGIN) return (window.height - menu.height) / 2
    const y = alignBottom ? window.height - menu.height : 0
    return Math.min(Math.max(y, VERTICAL_MARGIN), window.height - VERTICAL_MARGIN - menu.height)
  }
  const yCandidates = [
    anchor.y + anchor.height,
    anchor.y - menu.height,
    anchor.y - menu.height / 2,
    windowY(anchor.y + anchor.height / 2 >= window.height / 2),
  ]
  const y = yCandidates.find((value, index) => index === yCandidates.length - 1 || (value >= VERTICAL_MARGIN && value + menu.height <= window.height - VERTICAL_MARGIN))!
  return { x, y }
}

/**
 * Button order, top to bottom when stacked. Up to three follow RN's Android mapping: the last
 * is positive, the one before negative, the one before that neutral; stacked, AppCompat lists
 * positive, negative, neutral. More than three never happens on Android: the others keep that
 * reversed order and cancel-style buttons go last.
 */
export function alertButtonLayout(buttons: AlertButton[]): { row: { neutral?: AlertButton; negative?: AlertButton; positive?: AlertButton } | null; stacked: AlertButton[] } {
  if (buttons.length <= 3) {
    const [positive, negative, neutral] = [...buttons].reverse()
    return { row: { neutral, negative, positive }, stacked: [...buttons].reverse() }
  }
  const reversed = [...buttons].reverse()
  return { row: null, stacked: [...reversed.filter(button => button.style !== 'cancel'), ...reversed.filter(button => button.style === 'cancel')] }
}
