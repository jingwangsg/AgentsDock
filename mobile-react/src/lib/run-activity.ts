import type { Event } from '../types'
import { isTimelineError } from './timeline'

export interface RunActivity {
  startedAt: string
  finishedAt: string | null
  /** A user Stop; the desktop header reads "You stopped after …" for these. */
  stopped: boolean
}

/** The newest turn's lifecycle bounds, terminated the way the timeline projector terminates a turn (finish, stop, error). */
export function latestRunActivity(events: readonly Event[]): RunActivity | null {
  let current: (RunActivity & { runId: string | null }) | null = null
  for (const event of events) {
    if (event.type === 'turn_started') {
      current = { startedAt: event.ts, finishedAt: null, stopped: false, runId: event.run_id?.trim() || null }
      continue
    }
    if (!current || current.finishedAt) continue
    if (event.type !== 'turn_finished' && event.type !== 'turn_stopped' && !isTimelineError(event)) continue
    const runId = event.run_id?.trim()
    if (runId && current.runId && runId !== current.runId) continue
    current.finishedAt = event.ts
    current.stopped = event.type === 'turn_stopped' || Boolean(event.stopped)
  }
  return current ? { startedAt: current.startedAt, finishedAt: current.finishedAt, stopped: current.stopped } : null
}

/** `3s`, `3m 11s`, `1h 2m` — the desktop activity header's format. */
export function formatDuration(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  if (whole < 60) return `${whole}s`
  if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`
  return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`
}

export interface RunActivityLabel {
  live: boolean
  title: string
  elapsed: string | null
}

/**
 * `active` is the server's word that a turn is running (health/stream). The
 * events alone cannot say so between a queued turn's admission and its
 * `turn_started`, and a stale unfinished turn must never read as live.
 */
export function runActivityLabel(activity: RunActivity | null, active: boolean, now: number, activeSubagentNames: readonly string[] = []): RunActivityLabel | null {
  if (active) {
    const started = activity && !activity.finishedAt ? Date.parse(activity.startedAt) : Number.NaN
    // Claude Code CLI wording; the desktop header also lists only the first two names.
    const count = activeSubagentNames.length
    const running = count ? ` · ${count} ${count === 1 ? 'subagent' : 'subagents'} running (${activeSubagentNames.slice(0, 2).join(', ')})` : ''
    return { live: true, title: `Working…${running}`, elapsed: Number.isFinite(started) ? formatDuration((now - started) / 1000) : null }
  }
  if (!activity?.finishedAt) return null
  const start = Date.parse(activity.startedAt)
  const end = Date.parse(activity.finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  const duration = formatDuration((end - start) / 1000)
  return { live: false, title: activity.stopped ? `You stopped after ${duration}` : `Worked for ${duration}`, elapsed: null }
}
