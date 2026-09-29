// Port of electron/src/shared/chat-outputs.ts.
import type { CanvasSummary, CodeDiffFileSummary, Event } from '../types'

export type ChatOutputItem =
  | { kind: 'canvas'; label: string; name: string; path: string }
  | { kind: 'artifact'; label: string; eventId: string; filename: string; contentType: string | null }
  | { kind: 'local_preview'; url: string; host: string }
  | {
    kind: 'code_changes'
    filesChanged: number
    additions: number
    deletions: number
    /** Latest turn's diff: the review sheet loads one run at a time, so it cannot show the chat-wide totals above. */
    review: { runId: string | null; files: CodeDiffFileSummary[] | null; additions: number; deletions: number; repositoryRoot: string | null }
  }

export type ChatSourceItem =
  | { kind: 'mcp'; label: string; count: number; eventId: string }
  | { kind: 'web_search'; count: number; eventId: string }
  | { kind: 'web_fetch'; count: number; eventId: string }
  | { kind: 'skill'; label: string; eventId: string }
  | { kind: 'chat_reference'; label: string; eventId: string }
  | { kind: 'attached_file'; label: string; eventId: string }

export interface ChatOutputsSummary {
  outputs: ChatOutputItem[]
  sources: ChatSourceItem[]
}

/** Explicit-port HTTP loopback URLs (localhost, 127.x.x.x, 0.0.0.0, [::1]); same shape as the Electron collector. */
const LOCAL_URL_PATTERN = /http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))(?=[/?#\s)'"\]}>,]|$)[^\s)'"\]}>,]*/gi
const CANVAS_LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+?\.canvas\.tsx)(?:[?#][^)\s]*)?\)/gi

/** `_agentsdock_internal_provider_9f3a2c71` → `Agentsdock Internal Provider 9f3a2c71`. */
export function humanizeServerId(id: string): string {
  return id.replace(/^_+/, '').split(/[_-]+/).filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
}

export function collectChatOutputs(events: readonly Event[], canvases: readonly CanvasSummary[] = []): ChatOutputsSummary {
  const canvasLinkText = new Map<string, string>()
  const artifacts = new Map<string, ChatOutputItem>()
  const seenArtifactIds = new Set<string>()
  const previews = new Map<string, ChatOutputItem>()
  const codeDiffByRun = new Map<string, Event>()
  const mcpServers = new Map<string, { label: string; count: number; eventId: string }>()
  const webUses = new Map<'web_search' | 'web_fetch', { count: number; eventId: string }>()
  const skills = new Map<string, ChatSourceItem>()
  const chatReferences = new Map<string, ChatSourceItem>()
  const attachedFiles = new Map<string, string>()
  const uploads = new Map<string, string>()
  const seenToolIds = new Set<string>()

  for (const event of events) {
    const assistantText = event.type === 'assistant_text' ? event.text : event.type === 'turn_finished' ? event.result_text : null
    if (assistantText) {
      for (const match of assistantText.matchAll(CANVAS_LINK_PATTERN)) {
        const stem = match[2].split(/[\\/]/).pop()!.replace(/\.canvas\.tsx$/i, '')
        canvasLinkText.set(stem, match[1].trim())
      }
    }
    const urlText = assistantText ?? (event.type === 'tool_finished' ? event.output : null)
    if (urlText) {
      for (const match of urlText.matchAll(LOCAL_URL_PATTERN)) {
        const port = Number(match[1])
        if (port < 1 || port > 65_535) continue
        const host = match[0].slice('http://'.length).split(/[/?#]/, 1)[0]
        const origin = `http://${host.toLowerCase()}`
        if (previews.has(origin)) continue
        previews.set(origin, { kind: 'local_preview', url: match[0].replace(/[.,;:!?]+$/, ''), host })
      }
    }

    if (event.type === 'artifact_created' && event.artifact) {
      const file = event.artifact
      // A repeated event keeps an artifact's first row; a newer artifact published from the
      // same path replaces the older row and takes its position.
      if (seenArtifactIds.has(file.id)) continue
      seenArtifactIds.add(file.id)
      const key = file.source_path || file.id
      artifacts.delete(key)
      artifacts.set(key, {
        kind: 'artifact',
        label: file.title?.trim() || file.filename,
        eventId: event.id,
        filename: file.filename,
        contentType: file.content_type ?? null,
      })
    } else if (event.type === 'file_uploaded' && event.file) {
      uploads.set(event.file.id, event.file.filename)
    } else if (event.type === 'code_diff') {
      codeDiffByRun.set(event.run_id || event.id, event)
    } else if ((event.type === 'tool_started' || event.type === 'tool_finished') && event.tool?.name) {
      const toolId = event.tool.id || event.tool_id || event.id
      if (seenToolIds.has(toolId)) continue
      seenToolIds.add(toolId)

      // Claude names MCP tools `mcp__<server>__<tool>`, Codex app-server `<server>/<tool>`; anything else is built in.
      const name = event.tool.name.trim()
      let server: string | null = null
      let leaf = name
      if (name.startsWith('mcp__')) {
        const rest = name.slice('mcp__'.length)
        const split = rest.lastIndexOf('__')
        server = split > 0 ? rest.slice(0, split) : rest
        leaf = split > 0 ? rest.slice(split + 2) : ''
      } else if (name.lastIndexOf('/') > 0) {
        server = name.slice(0, name.lastIndexOf('/'))
        leaf = name.slice(name.lastIndexOf('/') + 1)
      }
      const lowerLeaf = leaf.toLowerCase()
      const webKind = lowerLeaf === 'websearch' || lowerLeaf === 'web_search' ? 'web_search'
        : lowerLeaf === 'webfetch' || lowerLeaf === 'web_fetch' || lowerLeaf === 'fetch' ? 'web_fetch'
          : null
      if (webKind) {
        const existing = webUses.get(webKind)
        if (existing) existing.count += 1
        else webUses.set(webKind, { count: 1, eventId: event.id })
      } else if (server) {
        const existing = mcpServers.get(server)
        if (existing) existing.count += 1
        else mcpServers.set(server, { label: humanizeServerId(server), count: 1, eventId: event.id })
      }
    } else if (event.type === 'turn_started') {
      const skill = event.skill_selection?.id
      if (skill && !skills.has(skill)) skills.set(skill, { kind: 'skill', label: skill, eventId: event.id })
      for (const reference of event.chat_references ?? []) {
        if (chatReferences.has(reference.session_id)) continue
        chatReferences.set(reference.session_id, { kind: 'chat_reference', label: reference.display_title_snapshot, eventId: event.id })
      }
      for (const fileId of event.file_ids ?? []) {
        if (!attachedFiles.has(fileId)) attachedFiles.set(fileId, event.id)
      }
    }
  }

  const outputs: ChatOutputItem[] = canvases.map(canvas => ({
    kind: 'canvas', label: canvasLinkText.get(canvas.name) ?? canvas.name, name: canvas.name, path: canvas.path,
  }))
  outputs.push(...artifacts.values(), ...previews.values())
  if (codeDiffByRun.size) {
    const diffs = [...codeDiffByRun.values()]
    // Paths dedupe across turns when the server listed them; otherwise fall back to the per-turn counts.
    const paths = new Set<string>()
    let filesChanged = 0
    let additions = 0
    let deletions = 0
    for (const diff of diffs) {
      additions += diff.additions ?? 0
      deletions += diff.deletions ?? 0
      if (diff.diff_files?.length) for (const file of diff.diff_files) paths.add(file.path)
      else filesChanged += diff.files_changed ?? 0
    }
    const latest = diffs.at(-1)!
    outputs.push({
      kind: 'code_changes',
      filesChanged: filesChanged + paths.size,
      additions,
      deletions,
      review: {
        runId: latest.run_id ?? null,
        files: latest.diff_files ?? null,
        additions: latest.additions ?? 0,
        deletions: latest.deletions ?? 0,
        repositoryRoot: latest.repository_root ?? null,
      },
    })
  }

  const sources: ChatSourceItem[] = [...mcpServers.values()].map(server => ({ kind: 'mcp', ...server }))
  for (const kind of ['web_search', 'web_fetch'] as const) {
    const use = webUses.get(kind)
    if (use) sources.push({ kind, ...use })
  }
  sources.push(...skills.values(), ...chatReferences.values())
  for (const [fileId, eventId] of attachedFiles) {
    const filename = uploads.get(fileId)
    if (filename) sources.push({ kind: 'attached_file', label: filename, eventId })
  }
  return { outputs, sources }
}
