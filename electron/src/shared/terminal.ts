/**
 * Standalone terminal tabs share the chat terminal WebSocket route but carry no chat
 * behind them: the server runs one shell per tab, shared by every attaching viewer, and
 * skips every tmux path. The id prefix is the single marker both ends agree on.
 */
export const STANDALONE_TERMINAL_PREFIX = 'term_'

/** WebSocket close code the server uses when the shell itself ended, as opposed to a dropped link. */
export const TERMINAL_SHELL_EXITED_CLOSE_CODE = 4410

export function isStandaloneTerminalId(id: string): boolean {
  return id.startsWith(STANDALONE_TERMINAL_PREFIX)
}
