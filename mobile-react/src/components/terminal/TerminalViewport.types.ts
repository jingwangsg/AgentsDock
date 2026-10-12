import type { NativeSyntheticEvent, ViewProps } from 'react-native'
import type { TerminalCursorStyle, TerminalFindOptions, TerminalKeyName, TerminalPageMessage } from '../../terminal/terminalPage'

export type { TerminalKeyName } from '../../terminal/terminalPage'

export type TerminalConnectionStatus = {
  /** Exited: the shell ended (Android web view terminal only). */
  status: 'Connecting' | 'Connected' | 'Reconnecting' | 'Error' | 'Disconnected' | 'Exited'
  name?: string
  message?: string
}

export type TerminalModifierState = { ctrl: boolean; alt: boolean }

/** What the Android terminal reports about its shell and its own controls. */
export type TerminalPageEvent = Extract<TerminalPageMessage, { type: 'title' | 'cwd' | 'bell' | 'notify' | 'find-results' | 'font-size' | 'command' }>

export type TerminalViewportHandle = {
  focus(): Promise<boolean>
  blur(): Promise<boolean>
  copy(): Promise<boolean>
  paste(): Promise<boolean>
  /** Only the Android web view terminal implements these; others leave them undefined. */
  sendKey?(name: TerminalKeyName): Promise<boolean>
  setModifier?(name: keyof TerminalModifierState, active: boolean): Promise<boolean>
  find?(query: string, options: TerminalFindOptions, direction: 1 | -1, incremental: boolean): Promise<boolean>
  clearFind?(): Promise<boolean>
  jumpPrompt?(direction: 'previous' | 'next'): Promise<boolean>
  selectText?(on: boolean): Promise<boolean>
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
  /** False while a kept terminal tab is hidden behind another tab or chat. */
  visible?: boolean
  /** The shell exited and no new one was asked for: the terminal does not connect until restart(). */
  exited?: boolean
  dark?: boolean
  cursorStyle?: TerminalCursorStyle
  cursorBlink?: boolean
  scrollback?: number
  screenReader?: boolean
  copyOnSelect?: boolean
  onPageEvent?: (event: TerminalPageEvent) => void
}
