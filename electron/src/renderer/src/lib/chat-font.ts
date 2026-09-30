import { useEffect } from 'react'
import { saveLocalStorage } from './local-storage'

export const CHAT_FONT_SIZES = [13, 14, 15, 16, 18, 20, 22, 24]
export const CHAT_FONT_FAMILIES: Array<[value: string, label: string]> = [
  ['system', 'System'],
  ['rounded', 'Rounded'],
  ['mono', 'Monospaced']
]
export const DEFAULT_CHAT_FONT_SIZE = 14
export const DEFAULT_CHAT_FONT_FAMILY = 'system'
const CHAT_FONT_SIZE_KEY = 'agentsdock:chat-font-size'
const CHAT_FONT_FAMILY_KEY = 'agentsdock:chat-font-family'

let currentSize = DEFAULT_CHAT_FONT_SIZE
let currentFamily = DEFAULT_CHAT_FONT_FAMILY

export function applyChatFont(size: number, family: string): void {
  currentSize = size
  currentFamily = family
  document.documentElement.style.setProperty('--chat-font-size', `${size}px`)
  document.documentElement.style.setProperty(
    '--chat-font-family',
    // "system" and "mono" follow the UI tokens so a skin (see zed-skin.css) can
    // supply its own faces; without a skin the tokens resolve to the system stacks.
    family === 'mono'
      ? 'var(--font-mono)'
      : family === 'rounded'
        ? 'ui-rounded, "SF Pro Rounded", -apple-system, sans-serif'
        : 'var(--font-ui)'
  )
}

/** Imperative size stepper for the native View menu (delta of ±1 step). */
export function nudgeChatFontSize(delta: number): void {
  const index = CHAT_FONT_SIZES.indexOf(currentSize)
  const base = index >= 0 ? index : CHAT_FONT_SIZES.indexOf(DEFAULT_CHAT_FONT_SIZE)
  const next = CHAT_FONT_SIZES[Math.max(0, Math.min(CHAT_FONT_SIZES.length - 1, base + delta))]
  setChatFontSize(next)
}

/** Imperative exact-size setter for the native View menu. */
export function setChatFontSize(size: number): void {
  if (!CHAT_FONT_SIZES.includes(size) || size === currentSize) return
  applyChatFont(size, currentFamily)
  saveLocalStorage(CHAT_FONT_SIZE_KEY, String(size))
}

/** Imperative typeface setter for the native View menu. */
export function setChatFontFamily(family: string): void {
  applyChatFont(currentSize, family)
  saveLocalStorage(CHAT_FONT_FAMILY_KEY, family)
}

/** Always-mounted, render-free applier of the saved chat font; the native View menu updates it imperatively. */
export function ChatFontApplier(): null {
  useEffect(() => applyChatFont(
    Number(window.localStorage.getItem(CHAT_FONT_SIZE_KEY)) || DEFAULT_CHAT_FONT_SIZE,
    window.localStorage.getItem(CHAT_FONT_FAMILY_KEY) ?? DEFAULT_CHAT_FONT_FAMILY
  ), [])
  return null
}
