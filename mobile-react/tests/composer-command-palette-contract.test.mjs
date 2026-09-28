import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const composer = fs.readFileSync(path.resolve('src/components/Composer.tsx'), 'utf8')
const palette = fs.readFileSync(path.resolve('src/components/ComposerCommandPalette.tsx'), 'utf8')
const runtimeSheet = fs.readFileSync(path.resolve('src/components/ComposerRuntimeSheet.tsx'), 'utf8')
const chatScreen = fs.readFileSync(path.resolve('src/components/ChatScreen.tsx'), 'utf8')
const appShell = fs.readFileSync(path.resolve('src/components/AppShell.tsx'), 'utf8')
const client = fs.readFileSync(path.resolve('src/api/AgentServerClient.ts'), 'utf8')
const store = fs.readFileSync(path.resolve('src/store/useAppStore.ts'), 'utf8')

test('the composer opens the slash palette from the draft and gates provider commands on the server capability', () => {
  assert.match(composer, /const commandTrigger = !welcome \? composerCommandTrigger\(draft, draft\.length\) : null/)
  assert.match(composer, /providerCommandsAvailable\(health, backend\)/)
  assert.match(composer, /client\.providerCommands\(sessionId, refresh\)/)
  assert.match(composer, /cacheProviderCommands\(key, snapshot\)/)
  assert.match(composer, /const commandPaletteVisible = Boolean\(commandTrigger && \(commandCandidates\.length > 0 \|\| activeProviderCommandState\.status === 'loading' \|\| activeProviderCommandState\.status === 'error'\)\)/)
  assert.match(composer, /\{commandPaletteVisible \? <ComposerCommandPalette[\s\S]*?onSelect=\{chooseCommand\}/)
  assert.match(palette, /testID="composer-command-palette"/)
  assert.match(palette, /testID=\{`composer-command-\$\{command\.id\}`\}/)
  assert.match(palette, /groupComposerCommandsByCategory\(commands, COMPOSER_COMMAND_CATEGORIES\)/)
  assert.match(palette, /Loading provider commands…/)
  assert.match(palette, /Provider commands could not be loaded\./)
})

test('each AgentsDock command runs through an existing mobile surface', () => {
  assert.match(composer, /case 'attach': chooseAttachment\(\); break/)
  assert.match(composer, /case 'chat': openTargetPicker\(\); break/)
  assert.match(composer, /case 'compact': void runCompactCommand\(\); break/)
  assert.match(composer, /case 'digest': onShellAction\('digest'\); break/)
  assert.match(composer, /case 'goal': openGoalCommand\(\); break/)
  assert.match(composer, /case 'mcp': onOpenMcp\(\); break/)
  assert.match(composer, /case 'model': case 'reasoning': openRuntimeSheet\(command\.id\); break/)
  assert.match(composer, /case 'new': onShellAction\('new-chat'\); break/)
  // Per-chat permission controls were removed: full access is the server default.
  assert.doesNotMatch(composer, /case 'permissions'|case 'plan'|PermissionMenu/)
  assert.match(composer, /case 'schedule': onShellAction\('job'\); break/)
  assert.match(composer, /case 'status': case 'workdir': onShellAction\('details'\); break/)
  assert.match(composer, /if \(command\.id === 'mail'\) \{ chooseMailCommand\(\); return \}/)
  assert.match(composer, /<ComposerRuntimeSheet[\s\S]*?models=\{runtimeCatalogOptions\(runtime, backend, 'models', model\)\}[\s\S]*?efforts=\{backend === 'cursor' \? \[\] : runtimeEffortOptions\(runtime, backend, model, effort\)\}/)
  assert.match(runtimeSheet, /const detail = locked \? option\.locked_reason\?\.trim\(\) : option\.description\?\.trim\(\)/)
  assert.match(composer, /<CodexGoalEditorSheet visible=\{goalEditorOpen\}/)
  assert.match(chatScreen, /onShellAction=\{onShellAction\}/)
  assert.match(appShell, /onShellAction=\{action => \{ if \(action === 'details'\) openOptions\(\); else if \(action === 'new-chat'\) void quickNewChat\(\); else openInspectorAction\(action\) \}\}/)
})

test('/goal and /compact follow the desktop server paths per backend', () => {
  // Codex goals go through the runtime context (same action as the goal bar); Claude uses PUT /claude/goal.
  assert.match(composer, /await codexRuntime\.updateGoal\(\{ objective: argument, status: 'active' \}\)/)
  assert.match(composer, /if \(argument\.toLocaleLowerCase\(\) === 'clear'\) await client\.clearClaudeGoal\(sessionId\)\s+else await client\.setClaudeGoal\(sessionId, argument\)/)
  assert.match(client, /setClaudeGoal\(sessionId: string, condition: string\)[\s\S]*?this\.put\(`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/claude\/goal`, \{ condition \}\)/)
  // A typed `/goal <objective>` is intercepted on send instead of reaching the agent as text.
  assert.match(composer, /const goalArgument = consumeComposer \? goalCommandArgument\(currentDraft\) : null/)
  assert.match(composer, /if \(goalArgument\) void setGoalFromCommand\(goalArgument\)\s+else openGoalCommand\(\)/)
  // Codex compaction is the native app-server operation; Claude sends its native /compact as a provider selection.
  assert.match(composer, /await codexRuntime\.run\(\(\) => client\.compactCodexThread\(sessionId\)\)/)
  assert.match(composer, /providerCommandForInvocation\(snapshot, backend, '\/compact'\)/)
  assert.match(composer, /await send\(false, compact\.command\.invocation, false, compact\.selection\)/)
})

test('provider selections ride the turn as skill_selection through the store and client', () => {
  assert.match(composer, /providerCommandBindingRef\.current = \{[\s\S]*?selection: command\.provider\.selection,/)
  assert.match(composer, /replaceDraft\(`\$\{command\.provider\.command\.invocation\} `\)/)
  assert.match(composer, /if \(binding && !draftUsesProviderCommand\(text, binding\)\) providerCommandBindingRef\.current = null/)
  assert.match(composer, /skillSelection: outgoingSkillSelection,/)
  assert.match(composer, /forgetProviderCommands\(providerCommandsKey\)/)
  assert.match(store, /skillSelection\?: ProviderCommandSelection/)
  assert.match(store, /teamReferences,\s+options\?\.skillSelection,\s+\)/)
  assert.match(client, /if \(skillSelection\) body\.skill_selection = \{ id: skillSelection\.id, revision: skillSelection\.revision \}/)
  assert.match(client, /provider-commands\?refresh=\$\{refresh \? 'true' : 'false'\}/)
})
