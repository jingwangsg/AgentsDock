import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import type { TerminalKeyName } from '../../terminal/terminalPage'

export type { TerminalKeyName } from '../../terminal/terminalPage'

export type TerminalConnectionStatus = {
  /** Exited: the shell ended (Android web view terminal only). */
  status: 'Connecting' | 'Connected' | 'Reconnecting' | 'Error' | 'Disconnected' | 'Exited'
  name?: string
  message?: string
}

export type TerminalModifierState = { ctrl: boolean; alt: boolean }

export type TerminalViewportHandle = {
  focus(): Promise<boolean>
  blur(): Promise<boolean>
  copy(): Promise<boolean>
  paste(): Promise<boolean>
  /** Only the Android web view terminal implements the key row; others leave these undefined. */
  sendKey?(name: TerminalKeyName): Promise<boolean>
  setModifier?(name: keyof TerminalModifierState, active: boolean): Promise<boolean>
  restart?(): Promise<boolean>
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
  /** Android web view terminal only, from here on. A terminal tab, which acknowledges output; not a chat's tmux session. */
  standalone?: boolean
  /** The shell exited and no new one was asked for: the terminal does not connect until restart(). */
  exited?: boolean
}
