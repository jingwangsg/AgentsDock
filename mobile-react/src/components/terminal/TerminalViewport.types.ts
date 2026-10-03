import type { NativeSyntheticEvent, ViewProps } from 'react-native'

export type TerminalConnectionStatus = {
  status: 'Connecting' | 'Connected' | 'Reconnecting' | 'Error' | 'Disconnected'
  name?: string
  message?: string
}

/** Keys the terminal key row can send; Ctrl and Alt are sticky modifiers applied to the next key. */
export type TerminalKeyName =
  | 'escape' | 'tab' | 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'dash' | 'slash' | 'pipe' | 'tilde'

export type TerminalModifierState = { ctrl: boolean; alt: boolean }

export type TerminalViewportHandle = {
  focus(): Promise<boolean>
  blur(): Promise<boolean>
  copy(): Promise<boolean>
  paste(): Promise<boolean>
  /** Only the Android web view terminal implements the key row; others leave these undefined. */
  sendKey?(name: TerminalKeyName): Promise<boolean>
  setModifier?(name: keyof TerminalModifierState, active: boolean): Promise<boolean>
}

export type TerminalViewportProps = ViewProps & {
  socketURL: string
  backgroundHex: string
  foregroundHex: string
  cursorHex: string
  selectionHex: string
  fontSize?: number
  onStatus?: (event: NativeSyntheticEvent<TerminalConnectionStatus>) => void
  onModifiers?: (state: TerminalModifierState) => void
}
