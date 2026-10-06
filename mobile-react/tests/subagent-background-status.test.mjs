import assert from 'node:assert/strict'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// The parser is a port of the desktop's; it runs for real here against the same frames.
const outfile = path.resolve('build/tmp', `subagents-${process.pid}.mjs`)
await mkdir(path.dirname(outfile), { recursive: true })
await build({ entryPoints: ['src/lib/subagents.ts'], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
after(async () => { await unlink(outfile) })
const { subagentsFromEvents, isSubagentActive } = await import(pathToFileURL(outfile).href)

const event = (seq, type, patch = {}) => ({ seq, id: `event-${seq}`, session_id: 'chat-1', run_id: 'run-1', type, ts: `2026-10-07T10:00:${String(seq).padStart(2, '0')}Z`, ...patch })

test('a background Claude agent stays running after its launch receipt and ends with its task frame', () => {
  const tool = { id: 'tool-bg', name: 'Agent', input: { description: 'Slow background probe', run_in_background: true } }
  const launched = [
    event(1, 'tool_started', { backend: 'claude', tool }),
    event(2, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'tool-bg', description: 'Slow background probe', is_backgrounded: true, task_type: 'local_agent' }) }),
    event(3, 'tool_finished', { backend: 'claude', tool_id: 'tool-bg', tool, output: 'Async agent launched successfully. (This tool result is internal metadata)' }),
  ]
  const [running] = subagentsFromEvents(launched)
  assert.equal(running.status, 'running')
  assert.equal(running.background, true)
  assert.equal(isSubagentActive(running), true)
  assert.deepEqual(running.log.map(entry => entry.text), ['Starting Slow background probe', 'Slow background probe', 'Running in the background'])
  const [done] = subagentsFromEvents([
    ...launched,
    event(4, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', status: 'completed', summary: 'PROBE_DONE' }) }),
    event(5, 'turn_finished', { backend: 'claude', exit_code: 0 }),
  ])
  assert.equal(done.status, 'completed')
  assert.equal(done.summary, 'PROBE_DONE')
})

test('a foreground Claude agent still completes with its tool result', () => {
  const tool = { id: 'tool-fg', name: 'Agent', input: { description: 'Quick check' } }
  const [quick] = subagentsFromEvents([
    event(1, 'tool_started', { backend: 'claude', tool }),
    event(2, 'tool_finished', { backend: 'claude', tool_id: 'tool-fg', tool, output: 'All good' }),
  ])
  assert.equal(quick.status, 'completed')
})

test('a background Claude agent completes from a task frame in a later run and survives the launching run ending', () => {
  const tool = { id: 'tool-bg', name: 'Agent', input: { description: 'Seventy second probe', run_in_background: true } }
  const launched = [
    event(1, 'tool_started', { backend: 'claude', tool }),
    event(2, 'raw_event', { backend: 'claude', raw: JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 'task-bg', tool_use_id: 'tool-bg', description: 'Seventy second probe', is_backgrounded: true, task_type: 'local_agent' }) }),
    event(3, 'tool_finished', { backend: 'claude', tool_id: 'tool-bg', tool, output: 'Async agent launched successfully.' }),
    event(4, 'turn_finished', { backend: 'claude', exit_code: 0 }),
  ]
  const [live] = subagentsFromEvents(launched)
  assert.equal(live.status, 'running')
  const agents = subagentsFromEvents([
    ...launched,
    event(5, 'turn_started', { backend: 'claude', run_id: 'run-2' }),
    event(6, 'raw_event', { backend: 'claude', run_id: 'run-2', raw: JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'task-bg', status: 'completed', summary: 'AGENT_DONE' }) }),
    event(7, 'turn_finished', { backend: 'claude', run_id: 'run-2', exit_code: 0 }),
  ])
  assert.equal(agents.length, 1)
  assert.equal(agents[0].status, 'completed')
  assert.equal(agents[0].runId, 'run-1')
})
