import { useSyncExternalStore } from 'react'

/**
 * What a terminal tab's shell reported about itself; it lives only in this app run. Port of
 * electron/src/renderer/src/lib/terminal-status.ts. The last report stays after a tab stops being kept, so
 * the chat list keeps naming it; the next attach's replay brings it up to date.
 */
interface TerminalStatus {
  /** OSC 0/2 window title. */
  title: string | null
  /** OSC 7 working directory. */
  cwd: string | null
  /** The shell rang the bell while the tab was hidden or the app was not in front. */
  bell: boolean
}

const EMPTY: TerminalStatus = { title: null, cwd: null, bell: false }
const statuses = new Map<string, TerminalStatus>()
const listeners = new Map<string, Set<() => void>>()

export function updateTerminalStatus(surfaceId: string, patch: Partial<TerminalStatus>): void {
  const current = statuses.get(surfaceId) ?? EMPTY
  if (Object.entries(patch).every(([key, value]) => current[key as keyof TerminalStatus] === value)) return
  statuses.set(surfaceId, { ...current, ...patch })
  for (const listener of listeners.get(surfaceId) ?? []) listener()
}

export function useTerminalStatus(surfaceId: string): TerminalStatus {
  return useSyncExternalStore(
    listener => {
      const set = listeners.get(surfaceId) ?? new Set()
      listeners.set(surfaceId, set.add(listener))
      return () => {
        set.delete(listener)
        if (!set.size) listeners.delete(surfaceId)
      }
    },
    () => statuses.get(surfaceId) ?? EMPTY,
  )
}
