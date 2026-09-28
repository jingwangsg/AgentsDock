import type { Backend, Health, ProviderCommand, ProviderCommandSelection, ProviderCommandsSnapshot } from '../types'

/**
 * Slash-command palette for the phone composer. The parser, filter and
 * grouping mirror electron/src/renderer/src/lib/composer-commands.ts so both
 * clients open and rank commands identically; the registry below is the
 * subset of desktop `COMPOSER_COMMANDS` that has a mobile surface.
 */

export interface ComposerCommandMetadata {
  id: string
  label: string
  description: string
  keywords?: readonly string[]
  /** Section this command is grouped under in the palette (e.g. 'agentsdock', 'skills'). */
  category?: string
}

export interface ComposerCommandTrigger {
  /** UTF-16 offset of the leading slash in the draft. */
  start: number
  /** UTF-16 caret offset immediately after the command query. */
  end: number
  /** Text after the slash, preserving the user's casing. */
  query: string
}

export interface ProviderComposerCommandDetails {
  command: ProviderCommand
  selection: ProviderCommandSelection
}

export interface ComposerCommand extends ComposerCommandMetadata {
  provider?: ProviderComposerCommandDetails
  meta?: string
}

export const COMPOSER_COMMANDS: readonly ComposerCommand[] = [
  { id: 'attach', label: 'Attach files', description: 'Choose files or photos for this message', keywords: ['upload', 'file', 'photo'], category: 'agentsdock' },
  { id: 'chat', label: 'Contact another chat', description: 'Reference a chat this agent can contact', keywords: ['handoff', 'mention', 'cross-chat', 'route'], category: 'agentsdock' },
  { id: 'compact', label: 'Compact context', description: 'Condense provider context without deleting this chat', keywords: ['context', 'summarize', 'memory'], category: 'agentsdock' },
  { id: 'digest', label: 'Create digest', description: 'Summarize this chat for a handoff', keywords: ['handoff', 'summary'], category: 'agentsdock' },
  { id: 'goal', label: 'Goal', description: 'Set or manage a persistent Codex goal', keywords: ['objective', 'long-running'], category: 'agentsdock' },
  { id: 'mail', label: 'Send Team Network mail', description: 'Message another server inbox', keywords: ['inbox', 'message', 'agent', 'server'], category: 'agentsdock' },
  { id: 'mcp', label: 'MCP servers', description: 'View and control Claude MCP connections', keywords: ['tools', 'connections', 'servers'], category: 'agentsdock' },
  { id: 'model', label: 'Model', description: 'Choose the model for this chat', keywords: ['runtime'], category: 'agentsdock' },
  { id: 'new', label: 'New chat', description: 'Create another chat', keywords: ['create'], category: 'agentsdock' },
  { id: 'reasoning', label: 'Reasoning', description: 'Choose the reasoning effort for this chat', keywords: ['effort', 'thinking'], category: 'agentsdock' },
  { id: 'schedule', label: 'Schedule', description: 'Create a scheduled job for this chat', keywords: ['job', 'cron', 'automation'], category: 'agentsdock' },
  { id: 'status', label: 'Status', description: 'Show chat and runtime details', keywords: ['context', 'connection', 'session'], category: 'agentsdock' },
  { id: 'workdir', label: 'Working directory', description: 'Change the folder used by this chat', keywords: ['cwd', 'directory', 'folder', 'project'], category: 'agentsdock' },
]

export const CLAUDE_GOAL_COMMAND_DESCRIPTION = 'Set or clear a persistent Claude goal'

/** Display order + heading for each command category, top to bottom in the palette. */
export const COMPOSER_COMMAND_CATEGORIES: readonly ComposerCommandCategory[] = [
  { id: 'agentsdock', heading: 'AgentsDock' },
  { id: 'skills', heading: 'Skills' },
  { id: 'claude-commands', heading: 'Claude commands' },
]

const AGENTSDOCK_COMMAND_IDS = new Set(COMPOSER_COMMANDS.map(command => command.id.toLocaleLowerCase()))

export type ComposerCommandAvailability<T extends ComposerCommandMetadata> = (command: T) => boolean

/**
 * Finds a slash command only when it is the first non-whitespace token in the
 * composer and the caret is at the end of that token. Arguments intentionally
 * end discovery, so `/goal keep tests green` is handled by the send path.
 */
export function composerCommandTrigger(text: string, caret: number): ComposerCommandTrigger | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length))
  if (safeCaret !== text.length) return null

  const slash = text.search(/\S/u)
  if (slash < 0 || text[slash] !== '/') return null
  const token = text.slice(slash, safeCaret)
  const match = /^\/([\p{L}\p{N}_.:-]*)$/u.exec(token)
  if (!match) return null

  return {
    start: slash,
    end: safeCaret,
    query: match[1],
  }
}

/** Filters in declaration order so the product-owned command ordering stays stable. */
export function filterComposerCommands<T extends ComposerCommandMetadata>(
  commands: readonly T[],
  query: string,
  isAvailable: ComposerCommandAvailability<T> = () => true,
): T[] {
  if (/\s/u.test(query)) return []
  const normalizedQuery = normalize(query)
  return commands.filter(command => (
    isAvailable(command)
    && (
      normalizedQuery.length === 0
      || commandSearchTerms(command).some(term => term.startsWith(normalizedQuery))
    )
  ))
}

export interface ComposerCommandCategory {
  id: string
  heading: string
}

export interface ComposerCommandGroup<T extends ComposerCommandMetadata> {
  id: string
  heading: string
  /** False when only one category is present, so a narrowed search doesn't show a lone redundant header. */
  showHeading: boolean
  items: { command: T; index: number }[]
}

/**
 * Groups already-filtered commands by category, preserving each command's
 * original flat index and declaration order within each group.
 */
export function groupComposerCommandsByCategory<T extends ComposerCommandMetadata>(
  commands: readonly T[],
  categories: readonly ComposerCommandCategory[],
  fallbackCategory = 'agentsdock',
): ComposerCommandGroup<T>[] {
  const byCategory = new Map<string, { command: T; index: number }[]>()
  commands.forEach((command, index) => {
    const category = command.category ?? fallbackCategory
    const bucket = byCategory.get(category) ?? []
    bucket.push({ command, index })
    byCategory.set(category, bucket)
  })
  const knownIds = categories.map(entry => entry.id)
  const orderedIds = [...knownIds, ...[...byCategory.keys()].filter(categoryId => !knownIds.includes(categoryId))]
  const groups = orderedIds
    .map(categoryId => ({
      id: categoryId,
      heading: categories.find(entry => entry.id === categoryId)?.heading ?? categoryId,
      items: byCategory.get(categoryId) ?? [],
    }))
    .filter(group => group.items.length > 0)
  return groups.map(group => ({ ...group, showHeading: groups.length > 1 }))
}

/** Server-advertised inventory route; older servers simply have no palette skills. */
export function providerCommandsAvailable(health: Health | null | undefined, backend: Backend | null | undefined): boolean {
  const capability = health?.capabilities?.local_provider_commands_v1
  if (!backend || backend === 'cursor' || capability?.available !== true) return false
  return !Array.isArray(capability.supported_backends) || capability.supported_backends.includes(backend)
}

export interface BoundProviderCommand {
  contextKey: string
  invocation: string
  name: string
  kind: string
  selection: ProviderCommandSelection
}

/** One inventory per server + chat + working directory; the chat's cwd changes which skills exist. */
export function providerCommandContextKey(
  profileId: string | null,
  profileGeneration: number,
  serverIdentity: string | null | undefined,
  session: { id: string; backend: Backend; cwd?: string | null } | null | undefined,
): string | null {
  if (!session || session.backend === 'cursor') return null
  return [
    profileId ?? 'local',
    profileGeneration,
    serverIdentity ?? 'unknown-server',
    session.id,
    session.backend,
    session.cwd?.trim() ?? '',
  ].join('\u0000')
}

export const PROVIDER_COMMAND_CACHE_TTL_MS = 30_000
const PROVIDER_COMMAND_CACHE_MAX_ENTRIES = 32
const providerCommandCache = new Map<string, { snapshot: ProviderCommandsSnapshot; expiresAt: number }>()

export function cacheProviderCommands(key: string, snapshot: ProviderCommandsSnapshot, now = Date.now()): void {
  providerCommandCache.delete(key)
  providerCommandCache.set(key, { snapshot, expiresAt: now + PROVIDER_COMMAND_CACHE_TTL_MS })
  while (providerCommandCache.size > PROVIDER_COMMAND_CACHE_MAX_ENTRIES) {
    const oldest = providerCommandCache.keys().next().value
    if (typeof oldest !== 'string') return
    providerCommandCache.delete(oldest)
  }
}

/** Returns a fresh snapshot (touching its recency) or null when missing/expired; expired entries are dropped. */
export function cachedProviderCommands(key: string, now = Date.now()): ProviderCommandsSnapshot | null {
  const cached = providerCommandCache.get(key)
  if (!cached) return null
  providerCommandCache.delete(key)
  if (cached.expiresAt <= now) return null
  providerCommandCache.set(key, cached)
  return cached.snapshot
}

export function forgetProviderCommands(key: string): void {
  providerCommandCache.delete(key)
}

function providerInvocation(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value !== value.trim()) return null
  // An invocation is a single slash token, never a local path or an argument-bearing prompt.
  return /^\/[\p{L}\p{N}_.:-]+$/u.test(value) ? value : null
}

function providerMetaPart(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const part = value.trim()
  if (!part || /^(?:file:|[a-z]:[\\/]|[\\/]{1,2})/iu.test(part)) return null
  return part
}

/** Sanitizes one server inventory into palette rows; AgentsDock-owned ids win over same-named provider commands. */
export function providerComposerCommands(snapshot: ProviderCommandsSnapshot | null, backend: Backend | null | undefined): ComposerCommand[] {
  if (!snapshot || !backend || snapshot.support?.available !== true || snapshot.backend !== backend || backend === 'cursor' || !Array.isArray(snapshot.commands)) return []
  const seenCommands = new Set<string>()
  return snapshot.commands.flatMap((command, index) => {
    if (!command || typeof command !== 'object') return []
    const invocation = providerInvocation(command.invocation)
    const opaqueId = typeof command.id === 'string' ? command.id.trim() : ''
    const revision = typeof snapshot.revision === 'string' ? snapshot.revision.trim() : ''
    const name = typeof command.name === 'string' ? command.name.trim() : ''
    const kind = typeof command.kind === 'string' ? command.kind.trim() : ''
    if (!invocation || !opaqueId || !revision || !name || !kind) return []
    if (AGENTSDOCK_COMMAND_IDS.has(invocation.slice(1).toLocaleLowerCase())) return []
    const label = typeof command.label === 'string' && command.label.trim() ? command.label.trim() : name
    const description = typeof command.description === 'string' ? command.description.trim() : ''
    const scope = providerMetaPart(command.scope)
    const source = providerMetaPart(command.source)
    const semanticKey = JSON.stringify([name, invocation, label, description, scope, source, kind])
    if (seenCommands.has(semanticKey)) return []
    seenCommands.add(semanticKey)
    const metaParts = [scope, source]
      .filter((value): value is string => Boolean(value))
      .filter((value, partIndex, values) => values.indexOf(value) === partIndex)
    return [{
      id: `provider-${index}`,
      label,
      description,
      keywords: [name, invocation.slice(1), kind, ...metaParts],
      category: backend === 'claude' ? 'claude-commands' : 'skills',
      meta: metaParts.join(' · '),
      provider: {
        command: { ...command, id: opaqueId, name, label, description, kind, invocation },
        selection: { id: opaqueId, revision },
      },
    }]
  })
}

/** Finds the provider-owned command for a slash token (e.g. Claude's native `/compact`). */
export function providerCommandForInvocation(snapshot: ProviderCommandsSnapshot | null, backend: Backend | null | undefined, invocation: string): ProviderComposerCommandDetails | null {
  if (!snapshot || !backend || snapshot.support?.available !== true || snapshot.backend !== backend || !Array.isArray(snapshot.commands)) return null
  const revision = typeof snapshot.revision === 'string' ? snapshot.revision.trim() : ''
  const command = snapshot.commands.find(candidate => candidate?.invocation === invocation && typeof candidate.id === 'string' && candidate.id.trim())
  if (!command || !revision) return null
  return { command, selection: { id: command.id.trim(), revision } }
}

export function draftUsesProviderCommand(text: string, binding: BoundProviderCommand): boolean {
  if (!text.startsWith(binding.invocation)) return false
  if (text.length === binding.invocation.length) return true
  // Keep this byte boundary identical to AgentsServer's revalidation rule.
  // Vertical tab and form feed are whitespace to JavaScript, but are not
  // valid provider-command argument separators on the wire.
  return /[\t\n\r ]/u.test(text[binding.invocation.length] ?? '')
}

/** `/goal` with an inline objective, e.g. `/goal keep the tests green`; the bare token returns an empty argument. */
export function goalCommandArgument(text: string): string | null {
  const match = /^\s*\/goal(?:\s+([\s\S]*?))?\s*$/iu.exec(text)
  if (!match) return null
  return (match[1] ?? '').trim()
}

function commandSearchTerms(command: ComposerCommandMetadata): string[] {
  const terms = [command.id, command.label, ...(command.keywords ?? [])]
  return [...new Set(terms.flatMap(value => {
    const normalized = normalize(value)
    if (!normalized) return []
    const words = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    return [normalized, normalized.replace(/[^\p{L}\p{N}]+/gu, ''), ...words]
  }))]
}

function normalize(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}
