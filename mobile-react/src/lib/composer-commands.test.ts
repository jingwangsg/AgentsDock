import type { Health, ProviderCommandsSnapshot } from '../types'
import {
  COMPOSER_COMMANDS,
  COMPOSER_COMMAND_CATEGORIES,
  PROVIDER_COMMAND_CACHE_TTL_MS,
  cacheProviderCommands,
  cachedProviderCommands,
  composerCommandTrigger,
  draftUsesProviderCommand,
  filterComposerCommands,
  forgetProviderCommands,
  goalCommandArgument,
  groupComposerCommandsByCategory,
  providerCommandContextKey,
  providerCommandForInvocation,
  providerCommandsAvailable,
  providerComposerCommands,
} from './composer-commands'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

// Trigger parsing mirrors desktop: leading slash + single token, caret at the end.
assert(composerCommandTrigger('/', 1)?.query === '', 'a lone slash opens the palette with an empty query')
assert(composerCommandTrigger('/goal', 5)?.query === 'goal', 'the token after the slash is the query')
assert(composerCommandTrigger('  /Goal', 7)?.start === 2, 'leading whitespace is allowed and the slash offset is reported')
assert(composerCommandTrigger('/goal ', 6) === null, 'an argument separator closes discovery')
assert(composerCommandTrigger('/goal keep tests green', 22) === null, 'arguments never reopen the palette')
assert(composerCommandTrigger('/goal', 3) === null, 'a caret before the end of the token does not trigger')
assert(composerCommandTrigger('hello /goal', 11) === null, 'a slash after other text is not a command')
assert(composerCommandTrigger('/Users/me/project', 17) === null, 'a path is not a single-token command')
assert(composerCommandTrigger('/plugin:skill', 13)?.query === 'plugin:skill', 'provider tokens may contain colons')
assert(composerCommandTrigger('', 0) === null, 'an empty draft has no trigger')

// Filtering keeps declaration order and matches id, label and keywords by prefix.
const ids = (query: string, available = () => true) => filterComposerCommands(COMPOSER_COMMANDS, query, available).map(command => command.id)
assert(ids('').join(',') === COMPOSER_COMMANDS.map(command => command.id).join(','), 'an empty query lists every command in registry order')
assert(ids('go').join(',') === 'goal', '/go narrows to goal')
assert(ids('GOAL').join(',') === 'goal', 'matching is case-insensitive')
assert(ids('comp').join(',') === 'compact', '/comp narrows to compact')
assert(ids('cwd').join(',') === 'workdir', 'keywords are searchable')
assert(ids('job').join(',') === 'schedule', 'schedule is reachable through its job keyword')
assert(ids('zzz').length === 0, 'an unmatched query yields no candidates')
assert(ids('goal x').length === 0, 'a query containing whitespace matches nothing')
assert(ids('', command => command.id !== 'mcp').includes('mcp') === false, 'availability removes commands')
for (const id of ['attach', 'chat', 'compact', 'digest', 'goal', 'mail', 'mcp', 'model', 'new', 'reasoning', 'schedule', 'status', 'workdir']) {
  assert(COMPOSER_COMMANDS.some(command => command.id === id), `registry must include /${id}`)
}

// Grouping: one visible category hides the heading; several show them in configured order.
const single = groupComposerCommandsByCategory(COMPOSER_COMMANDS, COMPOSER_COMMAND_CATEGORIES)
assert(single.length === 1 && single[0].showHeading === false, 'AgentsDock-only results render without a heading')

const claudeSnapshot: ProviderCommandsSnapshot = {
  backend: 'claude',
  revision: 'rev-1',
  support: { available: true, mode: 'native' },
  commands: [
    { id: 'cmd-compact', name: 'compact', label: 'compact', description: 'Clear conversation history but keep a summary', kind: 'command', invocation: '/compact' },
    { id: 'cmd-goal', name: 'goal', label: 'goal', description: 'Set a goal', kind: 'command', invocation: '/goal' },
    { id: 'cmd-review', name: 'review', label: 'review', description: 'Review a pull request', kind: 'command', invocation: '/review' },
    { id: 'cmd-review-dup', name: 'review', label: 'review', description: 'Review a pull request', kind: 'command', invocation: '/review' },
    { id: 'cmd-path', name: 'path', label: 'path', description: '', kind: 'command', invocation: '/Users/me/skill' },
    { id: '', name: 'noid', label: 'noid', description: '', kind: 'command', invocation: '/noid' },
    { id: 'cmd-scoped', name: 'pdf', label: 'PDF tools', description: 'Work with PDFs', kind: 'skill', scope: 'project', source: '/Users/me/.claude/skills', invocation: '/pdf' },
  ],
}
const claudeCommands = providerComposerCommands(claudeSnapshot, 'claude')
assert(claudeCommands.map(command => command.provider?.command.invocation).join(',') === '/review,/pdf',
  `provider merge must drop AgentsDock-owned tokens (/compact, /goal), duplicates, path-like invocations and id-less rows; got ${claudeCommands.map(command => command.provider?.command.invocation).join(',')}`)
assert(claudeCommands.every(command => command.category === 'claude-commands'), 'Claude inventory rows are grouped under Claude commands')
assert(claudeCommands[1].meta === 'project', 'filesystem-looking source metadata is hidden while scope stays visible')
assert(claudeCommands[0].provider?.selection.id === 'cmd-review' && claudeCommands[0].provider.selection.revision === 'rev-1', 'selections carry the opaque id and inventory revision')
assert(providerComposerCommands(claudeSnapshot, 'codex').length === 0, 'a snapshot for another backend is ignored')
assert(providerComposerCommands({ ...claudeSnapshot, support: { available: false, mode: 'unavailable' } }, 'claude').length === 0, 'an unavailable inventory contributes nothing')
assert(providerComposerCommands(null, 'claude').length === 0, 'no snapshot means no provider commands')
const codexSnapshot: ProviderCommandsSnapshot = { ...claudeSnapshot, backend: 'codex', commands: [{ id: 'skill-1', name: 'deploy', label: 'Deploy', description: '', kind: 'skill', invocation: '/deploy' }] }
assert(providerComposerCommands(codexSnapshot, 'codex')[0]?.category === 'skills', 'Codex inventory rows are grouped under Skills')

const merged = [...COMPOSER_COMMANDS, ...claudeCommands]
const groups = groupComposerCommandsByCategory(filterComposerCommands(merged, ''), COMPOSER_COMMAND_CATEGORIES)
assert(groups.map(group => group.id).join(',') === 'agentsdock,claude-commands', 'groups follow the configured category order')
assert(groups.every(group => group.showHeading), 'multiple groups show their headings')
assert(filterComposerCommands(merged, 'rev').map(command => command.label).join(',') === 'review', 'provider commands are searchable by name')
assert(filterComposerCommands(merged, 'pdf')[0]?.provider?.command.invocation === '/pdf', 'provider commands are searchable by invocation')

// The native `/compact` stays reachable for execution even though the palette hides it behind the AgentsDock row.
const compact = providerCommandForInvocation(claudeSnapshot, 'claude', '/compact')
assert(compact?.selection.id === 'cmd-compact' && compact.selection.revision === 'rev-1', 'the provider /compact resolves to its selection')
assert(providerCommandForInvocation(claudeSnapshot, 'codex', '/compact') === null, 'lookups respect the snapshot backend')
assert(providerCommandForInvocation(claudeSnapshot, 'claude', '/missing') === null, 'unknown invocations resolve to null')

// Binding survival matches the server's argument-separator rule.
const binding = { contextKey: 'k', invocation: '/pdf', name: 'pdf', kind: 'skill', selection: { id: 'cmd-scoped', revision: 'rev-1' } }
assert(draftUsesProviderCommand('/pdf', binding), 'the bare invocation keeps the binding')
assert(draftUsesProviderCommand('/pdf summarize this', binding), 'a space-separated argument keeps the binding')
assert(!draftUsesProviderCommand('/pdfx', binding), 'a longer token drops the binding')
assert(!draftUsesProviderCommand(' /pdf', binding), 'leading whitespace drops the binding (byte-zero contract)')
assert(!draftUsesProviderCommand('/pdf\u000bargs', binding), 'vertical tab is not a valid separator on the wire')

// /goal argument extraction for the send path.
assert(goalCommandArgument('/goal') === '', 'bare /goal yields an empty argument')
assert(goalCommandArgument('  /GOAL keep the tests green  ') === 'keep the tests green', 'the objective is trimmed and case-insensitive')
assert(goalCommandArgument('/goals now') === null, '/goals is not the goal command')
assert(goalCommandArgument('please /goal x') === null, 'the command must lead the draft')

// Capability gate + cache behaviour.
const health: Health = { ok: true, capabilities: { local_provider_commands_v1: { available: true, version: 1, supported_backends: ['codex', 'claude'] } } }
assert(providerCommandsAvailable(health, 'claude'), 'advertised backends are eligible')
assert(!providerCommandsAvailable(health, 'cursor'), 'cursor never lists provider commands')
assert(!providerCommandsAvailable({ ok: true }, 'claude'), 'older servers without the capability are ineligible')
assert(!providerCommandsAvailable({ ok: true, capabilities: { local_provider_commands_v1: { available: false } } }, 'claude'), 'an unavailable capability is ineligible')

const key = providerCommandContextKey('profile', 3, 'server-a', { id: 'chat', backend: 'claude', cwd: '/repo ' })
assert(key && key !== providerCommandContextKey('profile', 3, 'server-a', { id: 'chat', backend: 'claude', cwd: '/other' }), 'the working directory participates in the cache key')
assert(providerCommandContextKey('profile', 3, 'server-a', { id: 'chat', backend: 'cursor' }) === null, 'cursor chats have no inventory key')
assert(key)
assert(cachedProviderCommands(key) === null, 'nothing is cached initially')
cacheProviderCommands(key, claudeSnapshot, 1_000)
assert(cachedProviderCommands(key, 1_000 + PROVIDER_COMMAND_CACHE_TTL_MS - 1) === claudeSnapshot, 'a fresh entry is returned within the TTL')
assert(cachedProviderCommands(key, 1_000 + PROVIDER_COMMAND_CACHE_TTL_MS) === null, 'an entry at its expiry is dropped')
assert(cachedProviderCommands(key, 1_000) === null, 'an expired lookup evicts the entry')
cacheProviderCommands(key, claudeSnapshot, 1_000)
forgetProviderCommands(key)
assert(cachedProviderCommands(key, 1_000) === null, 'forgetting removes the entry')

console.log('composer-commands tests passed')
