import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasSummary, Event } from './types'
import { collectChatOutputs, humanizeServerId } from './chat-outputs'

let seq = 0
const event = (type: string, patch: Partial<Event> = {}): Event => {
  seq += 1
  return { id: `e${seq}`, seq, session_id: 'chat', type, ts: 't', ...patch }
}
const canvas = (name: string): CanvasSummary => ({ name, path: `canvases/${name}.canvas.tsx`, revision: 1, size: 10, updated_at: 't' })
const tool = (name: string, id: string): Event => event('tool_started', { tool: { id, name }, run_id: 'run' })

beforeEach(() => { seq = 0 })

describe('collectChatOutputs outputs', () => {
  it('labels canvases with the latest Markdown link text the assistant used, else the name', () => {
    const events = [
      event('assistant_text', { text: 'See [Budget v1](canvases/budget.canvas.tsx) and [Other](other.canvas.tsx?x=1).' }),
      event('turn_finished', { result_text: 'Updated: [Budget board](/w/canvases/budget.canvas.tsx).' })
    ]
    expect(collectChatOutputs(events, [canvas('budget'), canvas('plain')]).outputs).toEqual([
      { kind: 'canvas', label: 'Budget board', path: 'canvases/budget.canvas.tsx' },
      { kind: 'canvas', label: 'plain', path: 'canvases/plain.canvas.tsx' }
    ])
  })

  it('lists agent-produced files once, titled when a title exists, and points at the creating event', () => {
    const artifact = { id: 'art_1', filename: 'chart.png', content_type: 'image/png', title: 'Sales chart' }
    const events = [
      event('artifact_created', { artifact }),
      event('artifact_created', { artifact: { ...artifact, title: 'Renamed' } }),
      event('artifact_created', { artifact: { id: 'art_2', filename: 'report.pdf', content_type: 'application/pdf' } })
    ]
    expect(collectChatOutputs(events, []).outputs).toEqual([
      { kind: 'artifact', label: 'Sales chart', eventId: 'e1', filename: 'chart.png', contentType: 'image/png' },
      { kind: 'artifact', label: 'report.pdf', eventId: 'e3', filename: 'report.pdf', contentType: 'application/pdf' }
    ])
  })

  it('dedupes local preview URLs by origin across assistant text and tool output', () => {
    const events = [
      event('assistant_text', { text: 'Open http://localhost:5173/app. Or http://LOCALHOST:5173/other' }),
      event('tool_finished', { output: 'Listening on http://127.0.0.1:8000 and http://[::1]:8000/ and https://localhost:9999' }),
      event('tool_started', { output: 'http://localhost:4000 is not scanned on tool start' })
    ]
    expect(collectChatOutputs(events, []).outputs).toEqual([
      { kind: 'local_preview', url: 'http://localhost:5173/app', host: 'localhost:5173' },
      { kind: 'local_preview', url: 'http://127.0.0.1:8000', host: '127.0.0.1:8000' },
      { kind: 'local_preview', url: 'http://[::1]:8000/', host: '[::1]:8000' }
    ])
  })

  it('collapses code_diff events into one row, keeping the latest diff per run and the latest run for review', () => {
    const events = [
      event('code_diff', { run_id: 'run-1', files_changed: 9, additions: 100, deletions: 100 }),
      event('code_diff', { run_id: 'run-1', files_changed: 2, additions: 10, deletions: 3, diff_files: [{ path: 'a.ts', additions: 6, deletions: 1, binary: false }, { path: 'b.ts', additions: 4, deletions: 2, binary: false }] }),
      event('code_diff', { run_id: 'run-2', files_changed: 2, additions: 5, deletions: 1, repository_root: '/repo', diff_files: [{ path: 'b.ts', additions: 3, deletions: 1, binary: false }, { path: 'c.ts', additions: 2, deletions: 0, binary: false }] }),
      event('code_diff', { run_id: 'run-3', files_changed: 4, additions: 1, deletions: 1 })
    ]
    expect(collectChatOutputs(events, []).outputs).toEqual([{
      kind: 'code_changes',
      filesChanged: 7,
      additions: 16,
      deletions: 5,
      review: { runId: 'run-3', files: null, additions: 1, deletions: 1, repositoryRoot: null }
    }])
  })

  it('orders outputs as canvases, files, previews, code changes and reports none for an empty chat', () => {
    const events = [
      event('code_diff', { run_id: 'run', files_changed: 1, additions: 1, deletions: 0 }),
      event('assistant_text', { text: 'http://localhost:3000' }),
      event('artifact_created', { artifact: { id: 'art_1', filename: 'x.txt' } })
    ]
    expect(collectChatOutputs(events, [canvas('c')]).outputs.map(item => item.kind)).toEqual(['canvas', 'artifact', 'local_preview', 'code_changes'])
    expect(collectChatOutputs([], [])).toEqual({ outputs: [], sources: [] })
  })
})

describe('collectChatOutputs sources', () => {
  it('groups MCP tools by server for Claude and Codex naming and skips built-in tools', () => {
    const events = [
      tool('mcp___agentsdock_internal_provider_9f3a2c71__list', 'a'),
      tool('Bash', 'b'),
      tool('mcp___agentsdock_internal_provider_9f3a2c71__read', 'c'),
      tool('github/create_issue', 'd'),
      event('tool_finished', { tool_id: 'd', tool: { id: 'd', name: 'github/create_issue' }, output: 'ok' }),
      event('tool_finished', { tool: { name: 'github/list_issues' }, output: 'ok' })
    ]
    expect(collectChatOutputs(events, []).sources).toEqual([
      { kind: 'mcp', label: 'Agentsdock Internal Provider 9f3a2c71', count: 2, eventId: 'e1' },
      { kind: 'mcp', label: 'Github', count: 2, eventId: 'e4' }
    ])
  })

  it('counts web search and web fetch by tool leaf, including MCP-hosted fetch tools', () => {
    const events = [
      tool('WebSearch', 'a'),
      tool('web_search', 'b'),
      tool('WebFetch', 'c'),
      tool('mcp__fetch__fetch', 'd'),
      tool('browser/web_fetch', 'e')
    ]
    expect(collectChatOutputs(events, []).sources).toEqual([
      { kind: 'web_search', count: 2, eventId: 'e1' },
      { kind: 'web_fetch', count: 3, eventId: 'e3' }
    ])
  })

  it('lists skills, referenced chats and attached uploads from turn starts, resolving uploads in either order', () => {
    const events = [
      event('file_uploaded', { file: { id: 'file_1', filename: 'spec.md' } }),
      event('turn_started', {
        skill_selection: { id: 'review-pr', revision: 'r1' },
        chat_references: [{ session_id: 'other', display_title_snapshot: 'Planning chat', source_text_start: 0, source_text_end: 5, action: 'read' as never }],
        file_ids: ['file_1', 'file_2', 'file_missing']
      }),
      event('turn_started', {
        skill_selection: { id: 'review-pr', revision: 'r2' },
        chat_references: [{ session_id: 'other', display_title_snapshot: 'Planning chat (renamed)', source_text_start: 0, source_text_end: 5, action: 'read' as never }],
        file_ids: ['file_1']
      }),
      event('file_uploaded', { file: { id: 'file_2', filename: 'data.csv' } })
    ]
    expect(collectChatOutputs(events, []).sources).toEqual([
      { kind: 'skill', label: 'review-pr', eventId: 'e2' },
      { kind: 'chat_reference', label: 'Planning chat', eventId: 'e2' },
      { kind: 'attached_file', label: 'spec.md', eventId: 'e2' },
      { kind: 'attached_file', label: 'data.csv', eventId: 'e2' }
    ])
  })

  it('orders sources as MCP servers, web search, web pages, skills, chats, files', () => {
    const events = [
      event('file_uploaded', { file: { id: 'f', filename: 'f.txt' } }),
      event('turn_started', { file_ids: ['f'], skill_selection: { id: 's', revision: '1' }, chat_references: [{ session_id: 'x', display_title_snapshot: 'X', source_text_start: 0, source_text_end: 1, action: 'read' as never }] }),
      tool('WebFetch', 'a'),
      tool('WebSearch', 'b'),
      tool('mcp__srv__do', 'c')
    ]
    expect(collectChatOutputs(events, []).sources.map(item => item.kind)).toEqual(['mcp', 'web_search', 'web_fetch', 'skill', 'chat_reference', 'attached_file'])
  })
})

describe('humanizeServerId', () => {
  it('strips leading underscores, splits on separators and title-cases words', () => {
    expect(humanizeServerId('_agentsdock_internal_provider_9f3a2c71')).toBe('Agentsdock Internal Provider 9f3a2c71')
    expect(humanizeServerId('github-mcp')).toBe('Github Mcp')
    expect(humanizeServerId('plain')).toBe('Plain')
  })
})
