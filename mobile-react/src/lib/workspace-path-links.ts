// Path links in chat Markdown name files on the chat's server, which Linking
// cannot open. Like canvas-links.ts, a device event carries the request to the
// ChatScreen that owns the chat's cwd and the workspace file viewer.
import { DeviceEventEmitter } from 'react-native'

export const OPEN_WORKSPACE_PATH_EVENT = 'agentsdock:open-workspace-path'

export interface OpenWorkspacePathRequest {
  sessionId: string
  href: string
}

/** True when `href` is a chat path rather than a URL and the open request was dispatched, so the caller skips Linking. */
export function openWorkspacePathLink(href: string, sessionId: string | null): boolean {
  // Markdown without a chat (a previewed file) resolves relative links against
  // its own folder, not the chat cwd. One-letter "schemes" are Windows drives.
  if (!sessionId || !href.trim() || href.startsWith('#') || /^[a-z][a-z0-9+.-]+:/i.test(href)) return false
  DeviceEventEmitter.emit(OPEN_WORKSPACE_PATH_EVENT, { sessionId, href } satisfies OpenWorkspacePathRequest)
  return true
}
