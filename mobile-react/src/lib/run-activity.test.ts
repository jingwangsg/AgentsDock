import type { Event } from '../types'
import { formatDuration, latestRunActivity, runActivityLabel } from './run-activity'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${message}\n  actual:   ${left}\n  expected: ${right}`)
}

let seq = 0
const event = (type: string, ts: string, patch: Partial<Event> = {}): Event => {
  seq += 1
  return { id: `e${seq}`, seq, session_id: 'chat', type, ts, ...patch }
}
const T0 = '2026-09-28T10:00:00.000Z'
const T1 = '2026-09-28T10:03:11.000Z'
const T2 = '2026-09-28T10:10:00.000Z'
const at = (iso: string) => Date.parse(iso)

// formatDuration mirrors the desktop activity header.
assert(formatDuration(0) === '0s', 'zero reads 0s')
assert(formatDuration(-5) === '0s', 'negative clamps to 0s')
assert(formatDuration(Number.NaN) === '0s', 'NaN clamps to 0s')
assert(formatDuration(59.9) === '59s', 'sub-minute floors to seconds')
assert(formatDuration(191) === '3m 11s', 'minutes and seconds')
assert(formatDuration(3_720) === '1h 2m', 'hours and minutes drop seconds')

// latestRunActivity follows the newest turn and its own terminal packet.
assert(latestRunActivity([]) === null, 'no turns means no activity')
assertEqual(
  latestRunActivity([event('turn_started', T0, { run_id: 'run-1' })]),
  { startedAt: T0, finishedAt: null, stopped: false },
  'an open turn has no finish',
)
assertEqual(
  latestRunActivity([
    event('turn_started', T0, { run_id: 'run-1' }),
    event('assistant_text', T1, { run_id: 'run-1', text: 'hi' }),
    event('turn_finished', T1, { run_id: 'run-1' }),
  ]),
  { startedAt: T0, finishedAt: T1, stopped: false },
  'turn_finished closes the turn',
)
assertEqual(
  latestRunActivity([
    event('turn_started', T0, { run_id: 'run-1' }),
    event('turn_finished', T1, { run_id: 'run-0' }),
  ]),
  { startedAt: T0, finishedAt: null, stopped: false },
  'a late finish for an older run does not close the newest turn',
)
assertEqual(
  latestRunActivity([
    event('turn_started', T0, { run_id: 'run-1' }),
    event('turn_finished', T1, { run_id: 'run-1', stopped: true }),
  ]),
  { startedAt: T0, finishedAt: T1, stopped: true },
  'a stopped finish is recorded as a Stop',
)
assertEqual(
  latestRunActivity([
    event('turn_started', T0, { run_id: 'run-1' }),
    event('turn_stopped', T1, { run_id: 'run-1' }),
  ]),
  { startedAt: T0, finishedAt: T1, stopped: true },
  'turn_stopped is a Stop',
)
assertEqual(
  latestRunActivity([
    event('turn_started', T0, { run_id: 'run-1' }),
    event('error', T1, { run_id: 'run-1', message: 'boom' }),
  ]),
  { startedAt: T0, finishedAt: T1, stopped: false },
  'an error terminates the turn without counting as a Stop',
)
assertEqual(
  latestRunActivity([
    event('turn_started', T0, { run_id: 'run-1' }),
    event('turn_finished', T1, { run_id: 'run-1' }),
    event('turn_started', T2, { run_id: 'run-2' }),
  ]),
  { startedAt: T2, finishedAt: null, stopped: false },
  'a newer turn replaces the previous one',
)

// runActivityLabel: the server's active flag decides live vs summary.
assertEqual(
  runActivityLabel({ startedAt: T0, finishedAt: null, stopped: false }, true, at(T1)),
  { live: true, title: 'Working…', elapsed: '3m 11s' },
  'an active open turn shows Working with elapsed time',
)
assertEqual(
  runActivityLabel({ startedAt: T0, finishedAt: T1, stopped: false }, true, at(T2)),
  { live: true, title: 'Working…', elapsed: null },
  'active with the last turn already finished (next turn admitted) shows Working without a counter',
)
assertEqual(
  runActivityLabel(null, true, at(T2)),
  { live: true, title: 'Working…', elapsed: null },
  'active with no turn yet shows Working without a counter',
)
assertEqual(
  runActivityLabel({ startedAt: T0, finishedAt: T1, stopped: false }, false, at(T2)),
  { live: false, title: 'Worked for 3m 11s', elapsed: null },
  'a finished turn collapses to Worked for',
)
assertEqual(
  runActivityLabel({ startedAt: T0, finishedAt: T1, stopped: true }, false, at(T2)),
  { live: false, title: 'You stopped after 3m 11s', elapsed: null },
  'a stopped turn reads You stopped after',
)
assert(runActivityLabel({ startedAt: T0, finishedAt: null, stopped: false }, false, at(T2)) === null, 'an inactive session with an unfinished turn shows nothing rather than a false Working')
assert(runActivityLabel(null, false, at(T2)) === null, 'nothing to show for an idle empty chat')
assert(runActivityLabel({ startedAt: 'garbage', finishedAt: T1, stopped: false }, false, at(T2)) === null, 'unparseable timestamps hide the summary')

// Active subagents append their count and up to two names, as in the Claude Code CLI strip.
assertEqual(
  runActivityLabel({ startedAt: T0, finishedAt: null, stopped: false }, true, at(T1), ['Audit the renderer']),
  { live: true, title: 'Working… · 1 subagent running (Audit the renderer)', elapsed: '3m 11s' },
  'one active subagent reads singular with its name',
)
assertEqual(
  runActivityLabel({ startedAt: T0, finishedAt: null, stopped: false }, true, at(T1), ['Audit', 'Review', 'Fix']),
  { live: true, title: 'Working… · 3 subagents running (Audit, Review)', elapsed: '3m 11s' },
  'more than two active subagents list only the first two names',
)
assertEqual(
  runActivityLabel(null, true, at(T2), ['Audit']),
  { live: true, title: 'Working… · 1 subagent running (Audit)', elapsed: null },
  'the suffix does not need a turn start',
)
assertEqual(
  runActivityLabel({ startedAt: T0, finishedAt: T1, stopped: false }, false, at(T2), ['Audit']),
  { live: false, title: 'Worked for 3m 11s', elapsed: null },
  'a finished turn never carries the running suffix',
)

console.log('run activity regressions passed')
