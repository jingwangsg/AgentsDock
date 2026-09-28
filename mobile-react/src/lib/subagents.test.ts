// Ported from electron/src/renderer/src/lib/subagents.test.ts (English locale cases).
import assert from 'node:assert/strict'
import type { Event } from '../types'
import { isSubagentActive, subagentDetailText, subagentDisplayName, subagentLogText, subagentStatusLabel, subagentsFromEvents } from './subagents'

const event = (seq: number, type: string, patch: Partial<Event> = {}): Event => ({
  seq,
  id: `event-${seq}`,
  session_id: 'chat-1',
  run_id: 'run-1',
  type,
  ts: `2026-07-12T10:00:${String(seq).padStart(2, '0')}Z`,
  ...patch,
})

function matches(actual: unknown, expected: Record<string, unknown>, message: string): void {
  const record = actual as Record<string, unknown>
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(record[key], value, `${message}: ${key}`)
}

// does not mislabel OpenCode tasks or their backend-less continuations as Codex agents
assert.deepEqual(subagentsFromEvents([
  event(1, 'turn_started', { backend: 'opencode' as unknown as Event['backend'] }),
  event(2, 'tool_started', { tool: { name: 'agent', input: { description: 'spawn_agent' } }, tool_id: 'task-a' }),
  event(3, 'subagent_state', { subagent_id: 'child', subagent_status: 'running' }),
]), [], 'unsupported backends never produce rows')

// keeps separator-only task labels visible
for (const task of ['___', '---']) {
  const [agent] = subagentsFromEvents([event(1, 'subagent_state', {
    backend: 'codex', subagent_id: 'child-live', subagent_status: 'running',
    subagent_task: task, subagent_nickname: 'Kuhn',
  })])
  assert.equal(subagentDisplayName(agent), task, `separator-only task ${task} stays visible`)
}

// uses a readable task path for untitled live provider records
for (const title of [null, undefined]) {
  const state = event(1, 'subagent_state', {
    backend: 'codex', subagent_id: 'child-live', subagent_status: 'running',
    subagent_title: title, subagent_name: 'Kuhn', subagent_nickname: 'Kuhn',
    subagent_path: '/root/prepare_release_notes',
  })
  const [agent] = subagentsFromEvents([state])
  assert.equal(subagentDisplayName(agent), 'Prepare release notes')
  assert.equal(subagentDetailText(agent), 'Kuhn')
  assert.ok(subagentLogText(agent).includes('/root/prepare_release_notes'))
  matches(agent, { id: 'child-live', nickname: 'Kuhn', path: '/root/prepare_release_notes', status: 'running' }, 'untitled live record')
  assert.equal(state.subagent_name, 'Kuhn', 'the source record is not mutated')
}

// falls back to the task after a title clear without renaming or duplicating the child
{
  const state = event(1, 'subagent_state', {
    backend: 'codex', subagent_id: 'child-live', subagent_status: 'running',
    subagent_title: 'Release review', subagent_name: 'Kuhn', subagent_nickname: 'Kuhn',
    subagent_path: '/root/prepare_release_notes',
  })
  assert.equal(subagentDisplayName(subagentsFromEvents([state])[0]), 'Release review')
  const after = subagentsFromEvents([state, { ...state, seq: 2, id: 'event-2', subagent_title: null }])
  assert.equal(after.length, 1)
  assert.equal(subagentDisplayName(after[0]), 'Prepare release notes')
  assert.equal(subagentDetailText(after[0]), 'Kuhn')
  assert.equal(after[0].title, null)
}

// retains the nickname when no usable task or child path exists
{
  const [agent] = subagentsFromEvents([event(1, 'subagent_state', {
    backend: 'codex', subagent_id: 'child-live', subagent_status: 'running',
    subagent_title: null, subagent_name: 'Kuhn', subagent_nickname: 'Kuhn', subagent_path: '/root',
  })])
  assert.equal(subagentDisplayName(agent), 'Kuhn')
}

// uses the exact Codex display title and retains its nickname and path separately
{
  const [agent] = subagentsFromEvents([event(1, 'subagent_state', {
    backend: 'codex', subagent_id: 'child-1', subagent_status: 'running',
    subagent_title: 'Public resources', subagent_nickname: 'Kepler the 2nd',
    subagent_name: 'Kepler the 2nd', subagent_path: '/root/public_resources',
  })])
  assert.equal(subagentDisplayName(agent), 'Public resources')
  assert.equal(subagentDetailText(agent), 'Kepler the 2nd')
  assert.ok(subagentLogText(agent).includes('Kepler the 2nd'))
  assert.ok(subagentLogText(agent).includes('/root/public_resources'))
}

// keeps one child through rename, missing or malformed titles, and explicit clear
{
  const state = (seq: number, extra: Partial<Event> = {}) => event(seq, 'subagent_state', {
    backend: 'codex', subagent_id: 'child-1', subagent_status: 'completed',
    subagent_started_at: '2026-07-12T09:00:00Z', ...extra,
  })
  const events = [
    state(1, { subagent_title: 'Initial audit', subagent_nickname: 'Kepler the 2nd' }),
    state(2, { subagent_title: 'Review letters audit' }),
    state(3), state(4, { subagent_title: { wrong: 'shape' } as unknown as string }),
    state(5, { subagent_title: '[AgentsDock context] internal context' }),
  ]
  const [agent] = subagentsFromEvents(events)
  assert.equal(subagentsFromEvents(events).length, 1)
  assert.equal(subagentDisplayName(agent), 'Review letters audit')
  matches(agent, { key: 'codex:subagent:child-1', status: 'completed', startedAt: '2026-07-12T09:00:00Z' }, 'renamed child')
  for (const cleared of [null, '', '  ']) {
    const [after] = subagentsFromEvents([...events, state(6, { subagent_title: cleared }), state(7)])
    assert.equal(subagentDisplayName(after), 'Kepler the 2nd', `title cleared with ${JSON.stringify(cleared)}`)
    assert.equal(after.key, agent.key)
    assert.equal(isSubagentActive(after), false)
  }
}

// does not turn a cleared title into a persistent fallback name
{
  const [agent] = subagentsFromEvents([
    event(1, 'subagent_state', { subagent_id: 'child-1', subagent_status: 'running',
      subagent_title: 'Publications audit', subagent_name: 'Codex subagent' }),
    event(2, 'subagent_state', { subagent_id: 'child-1', subagent_status: 'running', subagent_title: null }),
  ])
  assert.equal(subagentDisplayName(agent), 'Codex subagent')
}

// renames a completed child without changing its original lifecycle time or key
{
  const completed = event(1, 'subagent_state', { backend: 'codex', subagent_id: 'child-1',
    subagent_title: 'Initial audit', subagent_nickname: 'Kepler the 2nd', subagent_status: 'completed',
    subagent_started_at: '2026-07-12T09:59:00Z', subagent_activity: 'Audit complete' })
  // Identity snapshots carry a new sequence but the server retains lifecycle ts.
  const renamed = { ...completed, seq: 2, id: 'event-2', subagent_title: 'Public resources' }
  const [before] = subagentsFromEvents([completed])
  const [after] = subagentsFromEvents([completed, renamed])
  assert.equal(subagentDisplayName(after), 'Public resources')
  matches(after, { key: before.key, startedAt: before.startedAt, updatedAt: before.updatedAt, status: 'completed', log: before.log }, 'rename keeps lifecycle')
  assert.equal(isSubagentActive(after), false)
}

// keeps exact-owner tracking loss inactive despite late raw or structured progress
{
  const raw = (seq: number, subtype: string, run = 'run-1') => event(seq, 'raw_event', {
    backend: 'claude', run_id: run,
    raw: JSON.stringify({ type: 'system', subtype, task_id: 'same-task', task_type: 'local_agent', tool_use_id: 'tool-one', description: 'Late progress' }),
  })
  const state = (seq: number, status: string) => event(seq, 'subagent_state', {
    backend: 'claude', run_id: 'run-1', subagent_id: 'same-task', subagent_tool_id: 'tool-one',
    subagent_status: status, subagent_activity: 'Completion is not confirmed',
  })
  const agents = subagentsFromEvents([
    raw(1, 'task_started'), state(2, 'tracking_lost'), raw(3, 'task_progress'),
    raw(4, 'task_started'), state(5, 'running'), raw(6, 'task_started', 'new-owner'), raw(7, 'task_progress'),
  ])
  assert.equal(agents.length, 2)
  const lost = agents.find(agent => agent.runId === 'run-1')!
  assert.equal(lost.status, 'tracking_lost')
  assert.equal(lost.latestActivity, 'Completion is not confirmed')
  assert.equal(isSubagentActive(lost), false)
  assert.equal(isSubagentActive(agents.find(agent => agent.runId === 'new-owner')!), true)
  assert.equal(subagentStatusLabel(lost.status), 'Tracking lost')
  assert.ok(subagentLogText(lost).includes('Tracking lost'))
}

// recognizes an explicitly observed killed task as inactive
{
  const [agent] = subagentsFromEvents([event(1, 'subagent_state', { backend: 'claude', subagent_id: 'task', subagent_status: 'killed' })])
  assert.equal(agent.status, 'killed')
  assert.equal(isSubagentActive(agent), false)
  assert.equal(subagentStatusLabel(agent.status), 'Killed')
}

// generated progress lines are plain English; names, statuses and provider output pass through
{
  const [agent] = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'claude', tool: { id: 'tool-a', name: 'Agent', input: { description: 'Review Prompt' } } }),
    event(2, 'tool_finished', { backend: 'claude', tool_id: 'tool-a', tool: { id: 'tool-a', name: 'Agent' }, output: 'Working on /tmp/Agent.txt' }),
  ])
  assert.equal(agent.name, 'Review Prompt')
  assert.equal(agent.status, 'completed')
  assert.deepEqual(agent.log.map(entry => entry.text), ['Starting Review Prompt', 'Working on /tmp/Agent.txt'])
  assert.ok(subagentLogText(agent).includes('completed'))
  assert.ok(subagentLogText(agent).includes('Working on /tmp/Agent.txt'))
}

// tracks a Claude local agent through progress, child tools, and completion
{
  const tool = { id: 'tool-agent', name: 'Agent', input: { description: 'Audit the renderer', subagent_type: 'general-purpose' } }
  const agents = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'claude', tool }),
    event(2, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tool-agent', description: 'Audit the renderer', subagent_type: 'general-purpose', task_type: 'local_agent' }) }),
    event(3, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_progress', task_id: 'task-1', description: 'Reading Timeline.tsx' }) }),
    event(4, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'assistant', parent_tool_use_id: 'tool-agent', message: { content: [{ type: 'tool_use', name: 'Bash', input: { description: 'Running timeline tests' } }] } }) }),
    event(5, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed', summary: 'Found one scroll race' }) }),
  ])
  assert.equal(agents.length, 1)
  matches(agents[0], { id: 'task-1', name: 'Audit the renderer', backend: 'claude', status: 'completed', latestActivity: 'Found one scroll race' }, 'claude lifecycle')
  const texts = agents[0].log.map(item => item.text)
  for (const expected of ['Reading Timeline.tsx', 'Running timeline tests', 'Found one scroll race']) assert.ok(texts.includes(expected), `log carries ${expected}`)
}

// ignores Claude background bash tasks that are not subagents
assert.deepEqual(subagentsFromEvents([
  event(1, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'bash-1', task_type: 'local_bash', description: 'Render video' }) }),
]), [], 'local_bash tasks are not subagents')

// merges a projected live state into the durable Claude tool lifecycle
{
  const tool = { id: 'tool-agent', name: 'Agent', input: { description: 'Audit the renderer' } }
  const agents = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'claude', tool }),
    event(4, 'subagent_state', {
      backend: 'claude',
      subagent_id: 'task-1',
      subagent_tool_id: 'tool-agent',
      subagent_name: 'Audit the renderer',
      subagent_kind: 'general-purpose',
      subagent_status: 'running',
      subagent_activity: 'Running timeline tests',
      subagent_started_at: '2026-07-12T10:00:01Z',
      subagent_log: [{ ts: '2026-07-12T10:00:04Z', text: 'Running timeline tests' }],
    }),
  ])
  assert.equal(agents.length, 1)
  matches(agents[0], { id: 'task-1', status: 'running', latestActivity: 'Running timeline tests' }, 'projected state merge')
}

// keeps a Codex collaborator live after parent turn_finished / turn_stopped / error
for (const [terminalType, patch] of [
  ['turn_finished', { exit_code: 0 }],
  ['turn_stopped', {}],
  ['error', { error: 'parent failed' }],
] as Array<[string, Partial<Event>]>) {
  const tool = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'scroll_audit', fork_turns: 'all' } }
  const agents = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'codex', tool }),
    event(2, 'tool_finished', { backend: 'codex', tool_id: 'spawn-1', tool, output: '{"task_name":"/root/scroll_audit"}' }),
    event(3, terminalType, { backend: 'codex', ...patch }),
  ])
  matches(agents[0], { name: 'scroll_audit', backend: 'codex', status: 'running', providerRef: '/root/scroll_audit' }, `collaborator survives ${terminalType}`)
}

// uses a stopped parent turn only for a non-authoritative Claude fallback
{
  const tool = { id: 'claude-agent', name: 'Agent', input: { description: 'Audit the renderer' } }
  const agents = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'claude', tool }),
    event(2, 'turn_finished', { backend: 'claude', stopped: true }),
  ])
  assert.equal(agents[0].status, 'stopped')
  assert.equal(agents[0].log.at(-1)?.text, 'Parent turn stopped')
}

// treats projected state as provider-neutral and keys it by child thread ID
{
  const tool = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'lifecycle_audit' } }
  const agents = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'codex', run_id: 'logical-run-1', tool }),
    event(2, 'subagent_state', {
      backend: 'codex', run_id: 'logical-run-1', subagent_id: 'child-thread-1', subagent_tool_id: 'spawn-1',
      subagent_name: 'Inspect lifecycle', subagent_kind: 'collaborator', subagent_status: 'pendingInit', subagent_provider_ref: 'child-thread-1',
    }),
    event(3, 'tool_finished', { backend: 'codex', run_id: 'logical-run-1', tool_id: 'spawn-1', tool, output: '{"task_name":"/root/lifecycle_audit"}' }),
    event(4, 'subagent_state', {
      backend: 'codex', run_id: 'logical-run-2', subagent_id: 'child-thread-1', subagent_tool_id: 'spawn-1',
      subagent_name: 'Inspect lifecycle', subagent_kind: 'collaborator', subagent_status: 'running', subagent_provider_ref: 'child-thread-1',
    }),
  ])
  assert.equal(agents.length, 1)
  matches(agents[0], { key: 'codex:subagent:child-thread-1', id: 'child-thread-1', runId: 'logical-run-2', backend: 'codex', status: 'running', providerRef: 'child-thread-1' }, 'child thread key')
}

// merges a cold-upgrade child snapshot with its prior Codex spawn card
{
  const tool = { id: 'spawn-legacy', name: 'spawn_agent', input: { task_name: 'lifecycle_audit' } }
  const agents = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'codex', run_id: 'old-run', tool }),
    event(2, 'tool_finished', { backend: 'codex', run_id: 'old-run', tool_id: 'spawn-legacy', tool, output: '{"task_name":"/root/lifecycle_audit"}' }),
    event(10, 'subagent_state', {
      backend: 'codex', run_id: null, subagent_id: 'child-thread-1', subagent_tool_id: 'child-thread-1',
      subagent_name: 'Inspect lifecycle', subagent_status: 'running', subagent_provider_ref: 'child-thread-1',
    }),
  ])
  assert.equal(agents.length, 1)
  matches(agents[0], { key: 'codex:subagent:child-thread-1', id: 'child-thread-1', name: 'Inspect lifecycle', status: 'running', providerRef: 'child-thread-1' }, 'cold-upgrade merge')
}

// preserves a new unmatched spawn after a cold-upgrade child snapshot
{
  const legacy = { id: 'spawn-legacy', name: 'spawn_agent', input: { task_name: 'legacy_audit' } }
  const fresh = { id: 'spawn-fresh', name: 'spawn_agent', input: { task_name: 'fresh_audit' } }
  const agents = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'codex', run_id: 'old-run', tool: legacy }),
    event(2, 'tool_finished', { backend: 'codex', run_id: 'old-run', tool_id: 'spawn-legacy', tool: legacy, output: '{"task_name":"/root/legacy_audit"}' }),
    event(10, 'subagent_state', { backend: 'codex', run_id: null, subagent_id: 'legacy-child', subagent_tool_id: 'legacy-child', subagent_status: 'completed' }),
    event(11, 'tool_started', { backend: 'codex', run_id: 'new-run', tool: fresh }),
    event(12, 'tool_finished', { backend: 'codex', run_id: 'new-run', tool_id: 'spawn-fresh', tool: fresh, output: '{"task_name":"/root/fresh_audit"}' }),
  ])
  assert.equal(agents.length, 2)
  assert.deepEqual(agents.map(agent => agent.id).sort(), ['legacy-child', 'spawn-fresh'])
  matches(agents.find(agent => agent.id === 'spawn-fresh'), { name: 'fresh_audit', status: 'running' }, 'fresh spawn survives')
}

// applies an explicit targeted state update to only that child
{
  const state = (seq: number, childId: string, status: string): Event => event(seq, 'subagent_state', {
    backend: 'codex', subagent_id: childId, subagent_tool_id: childId, subagent_name: childId, subagent_status: status, subagent_provider_ref: childId,
  })
  const agents = subagentsFromEvents([state(1, 'child-a', 'running'), state(2, 'child-b', 'running'), state(3, 'child-a', 'interrupted')])
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  assert.equal(byId.get('child-a')?.status, 'stopped')
  assert.equal(byId.get('child-b')?.status, 'running')
}

// does not let a parent terminal event override authoritative Claude state
{
  const agents = subagentsFromEvents([
    event(1, 'subagent_state', { backend: 'claude', subagent_id: 'task-1', subagent_tool_id: 'tool-agent', subagent_status: 'running' }),
    event(2, 'turn_finished', { backend: 'claude', stopped: true }),
  ])
  assert.equal(agents[0].status, 'running')
}

// ignores generic Codex coordination calls while preserving explicit spawned agents
{
  const operations = ['wait', 'wait_agent', 'list_agents', 'sendInput', 'send_message', 'followup_task', 'interrupt_agent', 'resumeAgent', 'closeAgent']
  const coordinationEvents = operations.map((description, index) => event(index + 2, 'tool_started', {
    tool: { id: `coordination-${index}`, name: 'Agent', input: { description } },
  }))
  const spawn = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'real_audit' } }
  const agents = subagentsFromEvents([
    event(1, 'turn_started', { backend: 'codex' }),
    ...coordinationEvents,
    event(20, 'tool_started', { tool: spawn }),
    event(21, 'tool_finished', { tool_id: 'spawn-1', tool: spawn, output: '{"task_name":"/root/real_audit"}' }),
  ], 'codex')
  assert.equal(agents.length, 1)
  matches(agents[0], { name: 'real_audit', backend: 'codex', status: 'running', providerRef: '/root/real_audit' }, 'coordination calls hidden')
}

// uses the owning chat backend for provider events that omit backend metadata
{
  const tool = { id: 'tool-agent', name: 'Agent', input: { description: 'Audit the renderer' } }
  const agents = subagentsFromEvents([event(1, 'tool_started', { backend: undefined, tool })], 'claude')
  assert.equal(agents.length, 1)
  matches(agents[0], { name: 'Audit the renderer', backend: 'claude', status: 'starting' }, 'owner backend fallback')
}

// keeps legacy Codex spawnAgent events while hiding legacy coordination calls
{
  const spawn = { id: 'legacy-spawn', name: 'Agent', input: { description: 'spawnAgent' } }
  const agents = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'codex', tool: spawn }),
    event(2, 'tool_finished', { backend: 'codex', tool_id: 'legacy-spawn', tool: spawn, output: '{"task_name":"/root/legacy_audit"}' }),
    event(3, 'tool_started', { backend: 'codex', tool: { id: 'legacy-wait', name: 'Agent', input: { description: 'wait' } } }),
  ], 'codex')
  assert.equal(agents.length, 1)
  matches(agents[0], { backend: 'codex', status: 'running', providerRef: '/root/legacy_audit' }, 'legacy spawnAgent')
}

// does not hide a Claude agent merely because its description is wait
{
  const agents = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'claude', tool: { id: 'claude-wait', name: 'Agent', input: { description: 'wait' } } }),
  ], 'claude')
  assert.equal(agents.length, 1)
  matches(agents[0], { backend: 'claude', name: 'wait', status: 'starting' }, 'claude wait agent')
}

// keeps a useful agent path when a later projected preview contains AgentsDock context
{
  const agents = subagentsFromEvents([
    event(1, 'subagent_state', { backend: 'codex', subagent_id: 'child-1', subagent_name: '/root/crash_log_correlation', subagent_status: 'running' }),
    event(2, 'subagent_state', { backend: 'codex', subagent_id: 'child-1', subagent_name: '[AgentsDock context] You are responding through AgentsDock.', subagent_status: 'completed' }),
  ])
  assert.equal(agents.length, 1)
  matches(agents[0], { name: '/root/crash_log_correlation', path: '/root/crash_log_correlation', status: 'completed' }, 'context preview ignored')
  assert.equal(subagentDisplayName(agents[0]), 'Crash log correlation')
  assert.equal(subagentDetailText(agents[0]), '/root/crash_log_correlation')
  assert.ok(!agents[0].name.includes('[AgentsDock context]'))
}

// keeps a useful spawn identity when a later projected name is only a provider placeholder
{
  const tool = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'readonly_round2' } }
  const [agent] = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'codex', tool }),
    event(2, 'tool_finished', { backend: 'codex', tool_id: 'spawn-1', tool, output: '{"task_name":"/root/readonly_round2"}' }),
    event(3, 'subagent_state', { backend: 'codex', subagent_id: 'child-1', subagent_tool_id: 'spawn-1', subagent_name: 'Codex subagent', subagent_status: 'running' }),
  ])
  matches(agent, { name: 'readonly_round2', task: 'readonly_round2', path: '/root/readonly_round2' }, 'placeholder name ignored')
  assert.equal(subagentDisplayName(agent), 'Readonly round2')
  assert.equal(subagentDetailText(agent), '/root/readonly_round2')
}

// does not let a native child-thread placeholder outrank an authoritative agent path
{
  const tool = { id: 'spawn-1', name: 'spawn_agent', input: { task_name: 'child-thread-1' } }
  const [agent] = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'codex', tool }),
    event(2, 'subagent_state', { backend: 'codex', subagent_id: 'child-thread-1', subagent_tool_id: 'spawn-1', subagent_name: '/root/readonly_round2', subagent_path: '/root/readonly_round2', subagent_status: 'running' }),
  ])
  matches(agent, { task: 'child-thread-1', path: '/root/readonly_round2' }, 'thread placeholder')
  assert.equal(subagentDisplayName(agent), 'Readonly round2')
  assert.equal(subagentDetailText(agent), '/root/readonly_round2')
  assert.ok(!subagentLogText(agent).includes('Task: child-thread-1'))
}

// updates a Claude task label from its authoritative task-started event
{
  const tool = { id: 'tool-agent', name: 'Agent', input: { description: 'Initial wrapper description', subagent_type: 'general-purpose' } }
  const [agent] = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'claude', tool }),
    event(2, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'task-1', tool_use_id: 'tool-agent', description: 'Authoritative task description', subagent_type: 'general-purpose', task_type: 'local_agent' }) }),
  ])
  matches(agent, { name: 'Authoritative task description', task: 'Authoritative task description' }, 'authoritative label')
  assert.equal(subagentDisplayName(agent), 'Authoritative task description')
}

// prefers the explicit task while retaining the authoritative nickname and path
{
  const state = event(1, 'subagent_state', { backend: 'codex', subagent_id: 'child-1', subagent_status: 'running' })
  Object.assign(state, { subagent_nickname: 'Leibniz the 2nd', subagent_path: '/root/readonly_round2', subagent_task: 'Investigate read-only files' })
  const [agent] = subagentsFromEvents([state])
  matches(agent, { name: 'Leibniz the 2nd', nickname: 'Leibniz the 2nd', path: '/root/readonly_round2', task: 'Investigate read-only files' }, 'explicit task')
  assert.equal(subagentDisplayName(agent), 'Investigate read-only files')
  assert.equal(subagentDetailText(agent), 'Leibniz the 2nd')
}

// unordered input (timeline events merged with snapshot records) is sorted by seq before parsing
{
  const agents = subagentsFromEvents([
    event(3, 'subagent_state', { backend: 'codex', subagent_id: 'child-a', subagent_status: 'completed' }),
    event(1, 'subagent_state', { backend: 'codex', subagent_id: 'child-a', subagent_status: 'running' }),
  ])
  assert.equal(agents.length, 1)
  assert.equal(agents[0].status, 'completed')
}

console.log('subagent parser regressions passed')
