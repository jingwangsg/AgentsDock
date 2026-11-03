import assert from 'node:assert/strict'
import { DIRECT_WARMING_PACE, REMOTE_WARMING_PACE, WARM_CHAT_LIMIT, drainedWarmingBytes, nextWarmingPause, warmChatOrder, warmingBudgetWaitMs } from './chat-warming'
import type { Session } from '../types'

const chat = (id: string, minute: number, extra: Partial<Session> = {}): Session => ({
  id, title: id, backend: 'claude', archived: false,
  latest_event_seq: 10, latest_event_at: `2026-11-03T08:${String(minute).padStart(2, '0')}:00.000Z`,
  latest_agent_event_seq: 10, last_read_agent_event_seq: 10, manual_unread: false,
  ...extra,
})

// Most recent first; among equal times pinned, then unread; never archived, scheduled-job runs, empty or the open chat.
const order = warmChatOrder([
  chat('old', 1),
  chat('newest', 50),
  chat('open', 59),
  chat('archived', 58, { archived: true }),
  chat('job-run', 57, { scheduled_job_run: { job_id: 'job-1', session_id: 'newest' } }),
  chat('empty', 56, { latest_event_seq: 0 }),
  chat('tie-plain', 30),
  chat('tie-unread', 30, { latest_agent_event_seq: 11 }),
  chat('tie-pinned', 30, { pinned: true }),
], 'open')
assert.deepEqual(order.map(value => value.id), ['newest', 'tie-pinned', 'tie-unread', 'tie-plain', 'old'])

// The cap keeps the most recent.
const many = Array.from({ length: WARM_CHAT_LIMIT + 5 }, (_, index) => chat(`chat-${index}`, index))
const capped = warmChatOrder(many, null)
assert.equal(capped.length, WARM_CHAT_LIMIT)
assert.equal(capped[0].id, `chat-${WARM_CHAT_LIMIT + 4}`)
assert.ok(!capped.some(value => value.id === 'chat-0'), 'the oldest fall off')

// A slow answer doubles the pause up to the limit; a quick one returns to the base pause.
assert.equal(nextWarmingPause(DIRECT_WARMING_PACE, 0, 100), DIRECT_WARMING_PACE.pauseMs)
assert.equal(nextWarmingPause(DIRECT_WARMING_PACE, DIRECT_WARMING_PACE.pauseMs, DIRECT_WARMING_PACE.slowMs), DIRECT_WARMING_PACE.pauseMs * 2)
assert.equal(nextWarmingPause(DIRECT_WARMING_PACE, 50_000, 10_000), DIRECT_WARMING_PACE.maxPauseMs)
assert.equal(nextWarmingPause(DIRECT_WARMING_PACE, 50_000, 100), DIRECT_WARMING_PACE.pauseMs)
// A remote behind the hub gets smaller pages, longer pauses and a smaller budget.
assert.ok(REMOTE_WARMING_PACE.pageLimit < DIRECT_WARMING_PACE.pageLimit && REMOTE_WARMING_PACE.pauseMs > DIRECT_WARMING_PACE.pauseMs
  && REMOTE_WARMING_PACE.bytesPerMinute < DIRECT_WARMING_PACE.bytesPerMinute)

// The budget drains at its rate per minute and holds the next request while more than a minute's worth is left.
const rate = 60_000
assert.equal(drainedWarmingBytes(90_000, 0, 30_000, rate), 60_000)
assert.equal(drainedWarmingBytes(10_000, 0, 30_000, rate), 0)
assert.equal(warmingBudgetWaitMs(0, 0, 0, rate), 0)
assert.equal(warmingBudgetWaitMs(rate, 0, 0, rate), 0, 'a minute’s worth at once is allowed')
assert.equal(warmingBudgetWaitMs(90_000, 0, 0, rate), 30_000)
// One answer eight times the budget holds the next one for seven minutes, not one: the average stays at the rate.
assert.equal(warmingBudgetWaitMs(8 * rate, 0, 0, rate), 7 * 60_000)
assert.equal(warmingBudgetWaitMs(8 * rate, 0, 7 * 60_000, rate), 0)

console.log('chat warming rules passed')
