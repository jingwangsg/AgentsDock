export const APP_SHORTCUTS = {
  newChat: { label: 'New chat', accelerator: 'CmdOrCtrl+N', mac: '⌘N', other: 'Ctrl+N' },
  openWorkspaceFile: { label: 'Open workspace file', accelerator: 'CmdOrCtrl+O', mac: '⌘O', other: 'Ctrl+O' },
  attachFiles: { label: 'Attach files', accelerator: 'CmdOrCtrl+Shift+O', mac: '⇧⌘O', other: 'Ctrl+Shift+O' },
  settings: { label: 'Settings', accelerator: 'CmdOrCtrl+,', mac: '⌘,', other: 'Ctrl+,' },
  findChat: { label: 'Switch chat', accelerator: 'CmdOrCtrl+P', mac: '⌘P', other: 'Ctrl+P' },
  renameChat: { label: 'Rename chat', accelerator: 'CmdOrCtrl+R', mac: '⌘R', other: 'Ctrl+R' },
  findInChat: { label: 'Find in chat', accelerator: 'CmdOrCtrl+F', mac: '⌘F', other: 'Ctrl+F' },
  nextWorkspaceTab: { label: 'Next workspace tab', accelerator: 'Control+Tab', mac: '⌃⇥', other: 'Ctrl+Tab' },
  previousWorkspaceTab: { label: 'Previous workspace tab', accelerator: 'Control+Shift+Tab', mac: '⌃⇧⇥', other: 'Ctrl+Shift+Tab' },
  focusLeftChatPane: { label: 'Focus left chat pane', mac: '⌥⌘←', other: 'Ctrl+Alt+←' },
  focusRightChatPane: { label: 'Focus right chat pane', mac: '⌥⌘→', other: 'Ctrl+Alt+→' },
  nextServer: { label: 'Next server', accelerator: 'Alt+Shift+]', mac: '⇧⌥]', other: 'Alt+Shift+]' },
  previousServer: { label: 'Previous server', accelerator: 'Alt+Shift+[', mac: '⇧⌥[', other: 'Alt+Shift+[' },
  switchServerByNumber: { label: 'Switch to server 1-9', mac: '⇧⌥1…9', other: 'Alt+Shift+1…9' },
  toggleSidebar: { label: 'Toggle chat list', mac: '⌘B', other: 'Ctrl+/' },
  toggleInspector: { label: 'Toggle inspector', accelerator: 'CmdOrCtrl+L', mac: '⌘L', other: 'Ctrl+L' },
  jumpLatest: { label: 'Jump to latest', accelerator: 'CmdOrCtrl+Down', mac: '⌘↓', other: 'Ctrl+↓' },
  closeSurface: { label: 'Close', accelerator: 'CmdOrCtrl+W', mac: '⌘W', other: 'Ctrl+W' },
  sendMessage: { label: 'Send message', mac: '↩', other: 'Enter' },
  steerMessage: { label: 'Steer now', mac: '⌘↩', other: 'Ctrl+Enter' },
  stopTurn: { label: 'Stop response', mac: '⎋', other: 'Esc' }
} as const

export type AppShortcutId = keyof typeof APP_SHORTCUTS
export type ShortcutPlatform = 'mac' | 'other'
export type AppShortcutGroupId = 'general' | 'navigation' | 'messaging'

export const APP_SHORTCUT_GROUPS = [
  {
    id: 'general',
    shortcuts: ['newChat', 'openWorkspaceFile', 'attachFiles', 'settings', 'findChat', 'renameChat', 'findInChat', 'closeSurface']
  },
  {
    id: 'navigation',
    shortcuts: ['nextWorkspaceTab', 'previousWorkspaceTab', 'focusLeftChatPane', 'focusRightChatPane', 'nextServer', 'previousServer', 'switchServerByNumber', 'toggleSidebar', 'toggleInspector', 'jumpLatest']
  },
  {
    id: 'messaging',
    shortcuts: ['sendMessage', 'steerMessage', 'stopTurn']
  }
] as const satisfies ReadonlyArray<{
  id: AppShortcutGroupId
  shortcuts: readonly AppShortcutId[]
}>

export function shortcutTranslationKey(id: AppShortcutId): string {
  return `shortcuts.action.${id}`
}

export function shortcutDisplay(id: AppShortcutId, platform: ShortcutPlatform): string {
  return APP_SHORTCUTS[id][platform]
}

export function shortcutKeycaps(id: AppShortcutId, platform: ShortcutPlatform): readonly string[] {
  const display = shortcutDisplay(id, platform)
  if (platform === 'other') return display.split('+')

  const characters = Array.from(display)
  const keycaps: string[] = []
  while (characters.length && ['⌘', '⌥', '⌃', '⇧'].includes(characters[0])) {
    keycaps.push(characters.shift()!)
  }
  if (characters.length) keycaps.push(characters.join(''))
  return keycaps
}

export function shortcutAccelerator(id: AppShortcutId): string {
  const shortcut = APP_SHORTCUTS[id] as { accelerator?: string }
  if (!shortcut.accelerator) throw new Error(`${id} is not registered as a native menu accelerator.`)
  return shortcut.accelerator
}

/**
 * The sidebar toggle is not a menu accelerator: ⌘B on macOS, Ctrl+/ elsewhere, and never Ctrl+B,
 * which is the terminal's tmux prefix. The renderer checks it on keydown; the main process checks
 * the same chord for keys typed into a browser tab's page, which never reach the renderer.
 */
export function isToggleSidebarChord(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  platform: ShortcutPlatform
): boolean {
  if (event.altKey || event.shiftKey) return false
  return platform === 'mac'
    ? event.metaKey && !event.ctrlKey && event.key.toLowerCase() === 'b'
    : event.ctrlKey && !event.metaKey && event.key === '/'
}
