import { describe, expect, it } from 'vitest'
import { DIRECT_WARMING_PACE, WARM_CHAT_LIMIT, nextWarmingPause, warmChatOrder, warmingBucketLevel, warmingBudgetWaitMs } from './chat-warming'
import type { Session } from '../shared/types'

const chat = (id: string, minute: number, extra: Partial<Session> = {}): Session => ({
  id, title: id, backend: 'claude', archived: false,
  latest_event_seq: 10, latest_event_at: `2026-11-03T08:${String(minute).padStart(2, '0')}:00.000Z`,
  latest_agent_event_seq: 10, last_read_agent_event_seq: 10, manual_unread: false,
  ...extra
})

describe('warming order', () => {
  it('orders by latest activity, pinned then unread first among equal times, and leaves out archived, job runs, empty, open and uncached chats', () => {
    const order = warmChatOrder([
      chat('old', 1),
      chat('newest', 50),
      chat('open', 59),
      chat('archived', 58, { archived: true }),
      chat('job-run', 57, { scheduled_job_run: { job_id: 'job-1', session_id: 'newest' } }),
      chat('empty', 56, { latest_event_seq: 0 }),
      chat('uncached', 55),
      chat('tie-plain', 30),
      chat('tie-unread', 30, { latest_agent_event_seq: 11 }),
      chat('tie-pinned', 30, { pinned: true })
    ], new Set(['open']), id => id === 'uncached' ? 0 : 7)
    expect(order.map(({ session }) => session.id)).toEqual(['newest', 'tie-pinned', 'tie-unread', 'tie-plain', 'old'])
    expect(order.every(({ cachedThrough }) => cachedThrough === 7)).toBe(true)
  })

  it('keeps the most recent chats that have a cached timeline, up to the limit', () => {
    const many = Array.from({ length: WARM_CHAT_LIMIT + 10 }, (_, index) => chat(`chat-${index}`, index))
    // The newest five have no timeline on this device: the cap counts only chats that do.
    const uncached = new Set(many.slice(-5).map(session => session.id))
    const order = warmChatOrder(many, new Set(), id => uncached.has(id) ? 0 : 1)
    expect(order).toHaveLength(WARM_CHAT_LIMIT)
    expect(order[0].session.id).toBe(`chat-${WARM_CHAT_LIMIT + 4}`)
    expect(order.at(-1)!.session.id).toBe('chat-5')
  })
})

describe('warming pace', () => {
  it('doubles the pause after a slow answer up to the limit, and returns to the base pause after a quick one', () => {
    expect(nextWarmingPause(DIRECT_WARMING_PACE, 0, 100)).toBe(DIRECT_WARMING_PACE.pauseMs)
    expect(nextWarmingPause(DIRECT_WARMING_PACE, DIRECT_WARMING_PACE.pauseMs, DIRECT_WARMING_PACE.slowMs)).toBe(DIRECT_WARMING_PACE.pauseMs * 2)
    expect(nextWarmingPause(DIRECT_WARMING_PACE, 50_000, 10_000)).toBe(DIRECT_WARMING_PACE.maxPauseMs)
    expect(nextWarmingPause(DIRECT_WARMING_PACE, 50_000, 100)).toBe(DIRECT_WARMING_PACE.pauseMs)
  })
})

describe('warming byte budget', () => {
  const rate = 60_000
  it('drains at its rate per minute', () => {
    expect(warmingBucketLevel(90_000, 0, 30_000, rate)).toBe(60_000)
    expect(warmingBucketLevel(10_000, 0, 30_000, rate)).toBe(0)
  })

  it('holds the next request while more than a minute’s worth is undrained', () => {
    expect(warmingBudgetWaitMs(0, 0, 0, rate)).toBe(0)
    expect(warmingBudgetWaitMs(rate, 0, 0, rate)).toBe(0)
    expect(warmingBudgetWaitMs(90_000, 0, 0, rate)).toBe(30_000)
    // One answer eight times the budget holds the next one for seven minutes, not one: the average stays at the rate.
    expect(warmingBudgetWaitMs(8 * rate, 0, 0, rate)).toBe(7 * 60_000)
    expect(warmingBudgetWaitMs(8 * rate, 0, 7 * 60_000, rate)).toBe(0)
  })
})
