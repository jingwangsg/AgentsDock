// Chats nobody has open are kept up to date in the background, a small page at a time, so opening one after a while
// reads only its newest rows instead of one large catch-up. These rules decide which chats and how fast; the service
// runs them (AppService's warming). They mirror mobile-react/src/lib/chat-warming.ts, except that the 30-chat cap
// counts only chats with a cached timeline.
import { sessionUnread } from '../shared/chat-visibility'
import type { Session } from '../shared/types'

/** At most this many chats are kept warm. */
export const WARM_CHAT_LIMIT = 30

export interface WarmingPace {
  /** Visible rows per page request. */
  pageLimit: number
  /** Pause after a request that was not slow. */
  pauseMs: number
  /** A request at least this slow doubles the pause, up to maxPauseMs. */
  slowMs: number
  maxPauseMs: number
  /** Response bytes (JSON) a minute, on average. */
  bytesPerMinute: number
}

export const DIRECT_WARMING_PACE: WarmingPace = { pageLimit: 40, pauseMs: 1_500, slowMs: 2_000, maxPauseMs: 60_000, bytesPerMinute: 1_000_000 }
// A remote behind the hub shares one slow tunnel with everything the user does there, and the tunnel drops when a
// connection's backlog grows: about 2 KB/s on average, far below the 100-400 KiB/s such links carry.
export const REMOTE_WARMING_PACE: WarmingPace = { pageLimit: 20, pauseMs: 5_000, slowMs: 2_000, maxPauseMs: 120_000, bytesPerMinute: 128_000 }

/**
 * The chats kept warm, in the order they are brought up to date: the most recent ones with a cached timeline
 * (`cachedThrough` above 0), most recent activity first, pinned then unread ones first among equals. Archived
 * chats, scheduled-job run chats and the open ones (they have their own stream) are left out.
 */
export function warmChatOrder(
  sessions: readonly Session[],
  openSessionIds: ReadonlySet<string>,
  cachedThrough: (sessionId: string) => number
): Array<{ session: Session; cachedThrough: number }> {
  const recent = sessions
    .filter(session => !openSessionIds.has(session.id) && !session.archived && !session.scheduled_job_run && (session.latest_event_seq ?? 0) > 0)
    .sort((left, right) => (right.latest_event_at ?? '').localeCompare(left.latest_event_at ?? '')
      || Number(Boolean(right.pinned)) - Number(Boolean(left.pinned))
      || Number(sessionUnread(right)) - Number(sessionUnread(left)))
  const warm: Array<{ session: Session; cachedThrough: number }> = []
  for (const session of recent) {
    const through = cachedThrough(session.id)
    if (through <= 0) continue
    warm.push({ session, cachedThrough: through })
    if (warm.length === WARM_CHAT_LIMIT) break
  }
  return warm
}

/** The pause before the next request: the base pause, doubled after each slow answer, up to the limit. */
export function nextWarmingPause(pace: WarmingPace, previousPauseMs: number, lastRequestMs: number): number {
  return lastRequestMs >= pace.slowMs ? Math.min(pace.maxPauseMs, Math.max(pace.pauseMs, previousPauseMs) * 2) : pace.pauseMs
}

// The byte budget is a leaky bucket: bytes read drain at bytesPerMinute, and the next request waits while more than
// a minute's worth is undrained, however large one answer was.

/** Bytes still in the bucket at `now`, from `level` at `since`. */
export function warmingBucketLevel(level: number, since: number, now: number, bytesPerMinute: number): number {
  return Math.max(0, level - (now - since) * bytesPerMinute / 60_000)
}

/** How long the next request waits for the bucket to drain to a minute's worth. */
export function warmingBudgetWaitMs(level: number, since: number, now: number, bytesPerMinute: number): number {
  const undrained = warmingBucketLevel(level, since, now, bytesPerMinute)
  return undrained > bytesPerMinute ? Math.ceil((undrained - bytesPerMinute) * 60_000 / bytesPerMinute) : 0
}
