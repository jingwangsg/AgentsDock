// Canvas links render deep inside the timeline list. Like the desktop's
// `agentsdock:open-canvas` window event, a device event carries the request to
// the ChatScreen that owns the sheet, so no prop has to thread through the rows.
import { DeviceEventEmitter } from 'react-native'
import { canvasNameFromPath } from './canvas-page'

export const OPEN_CANVAS_EVENT = 'agentsdock:open-canvas'

export interface OpenCanvasRequest {
  /** Chat the link was rendered in; null when the renderer did not know (the open chat then takes it). */
  sessionId: string | null
  name: string
}

/** True when `href` names a Canvas and the open request was dispatched, so the caller skips Linking. */
export function openCanvasLink(href: string, sessionId: string | null): boolean {
  const name = canvasNameFromPath(href)
  if (!name) return false
  DeviceEventEmitter.emit(OPEN_CANVAS_EVENT, { sessionId, name } satisfies OpenCanvasRequest)
  return true
}
