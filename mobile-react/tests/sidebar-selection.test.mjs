import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(path.resolve('src/components/Sidebar.tsx'), 'utf8')

test('sidebar list explicitly invalidates recycled rows when selection changes', () => {
  assert.match(source, /const listState = useMemo\(\(\) => \(\{ active, selected, openingSearchResultId \}\)/)
  assert.match(source, /<FlatList[\s\S]*?extraData=\{listState\}/)
  assert.match(source, /accessibilityState=\{\{ selected, disabled: opening \}\}/)
})

test('chat taps on both platforms stay on a plain native press target', () => {
  const rowPress = source.match(/const pressableRow = \(([\s\S]*?)\n  \)\n  \/\/ The chat identity/)?.[1] ?? ''
  assert.match(rowPress, /if \(!sessionScopeIsCurrent\(profileScope, session\.id\)\) return[\s\S]*?onPress\(\)/)
  assert.match(source, /onLongPress=\{welcome \? undefined : Platform\.OS === 'ios' \? openActionSheet : \(\) => menu\.current\?\.show\(\)\}/)
  assert.match(source, /if \(welcome \|\| Platform\.OS === 'ios'\) return pressableRow/)
  assert.doesNotMatch(source, /from 'react-native-gesture-handler\/ReanimatedSwipeable'|<ReanimatedSwipeable|SwipeableMethods/)
  assert.doesNotMatch(source, /<MenuView[^>]*>\{pressableRow\}<\/MenuView>/)
})

test('Android chat and folder actions open from a long press on a collapsed sibling anchor', () => {
  assert.match(source, /<View style=\{styles\.sessionShell\}>\{pressableRow\}<MenuView ref=\{menu\} testID=\{`chat-actions-\$\{session\.id\}`\}/)
  assert.match(source, /<View style=\{styles\.folderHeaderShell\}>\{header\}<MenuView ref=\{menu\} testID=\{`folder-actions-\$\{item\.folder\}`\}/)
  assert.match(source, /onLongPress=\{!hasMenu \? undefined : Platform\.OS === 'ios' \? openActionSheet : \(\) => menu\.current\?\.show\(\)\}/)
  assert.match(source, /menuAnchor: \{ width: 0, justifyContent: 'flex-end', pointerEvents: 'none' \}/)
  // Compose only tracks a drawn (non-zero) anchor, so the trigger keeps a 1pt child.
  assert.match(source, /menuAnchorContent: \{ width: 1, height: 1 \}/)
  assert.equal(source.match(/style=\{styles\.menuAnchor\}><View style=\{styles\.menuAnchorContent\} \/><\/MenuView>/g)?.length, 2)
  assert.doesNotMatch(source, /MoreHorizontal|AndroidMoreMenu/)
})

test('folder menus offer new Claude/Codex chats in that folder on both platforms', () => {
  assert.match(source, /\{ id: 'new-claude', title: 'New Claude chat', image: 'plus' \},\s*\{ id: 'new-codex', title: 'New Codex chat', image: 'plus' \}/)
  assert.match(source, /\{ id: 'new-claude', title: 'New Claude chat' \},\s*\{ id: 'new-codex', title: 'New Codex chat' \}/)
  assert.match(source, /if \(id === 'new-claude'\) onNewChat\('claude'\)[\s\S]*?else if \(id === 'new-codex'\) onNewChat\('codex'\)/)
  assert.match(source, /onNewChat=\{backend => onNewChatIn\(item\.folder, backend\)\}/)
})

test('folders other than General can be renamed from their menu on both platforms', () => {
  assert.match(source, /\.\.\.\(movable \? \[\s*\{ id: 'rename', title: 'Rename Folder', image: 'pencil' \} satisfies MenuAction,/)
  assert.match(source, /\.\.\.\(movable \? \[\{ id: 'rename', title: 'Rename Folder' \}\] : \[\]\),/)
  assert.match(source, /else if \(id === 'rename'\) onRename\(\)/)
  assert.match(source, /onRename=\{\(\) => renameFolder\(item\.folder\)\}/)
  // Refuses empty/unchanged/duplicate names, moves every chat first, then renames the order and collapsed entries.
  assert.match(source, /const renameFolder = \(folder: string\) => \{[\s\S]*?promptText\(\{[\s\S]*?title: 'Rename folder',[\s\S]*?initialValue: folder,[\s\S]*?confirmLabel: 'Rename',[\s\S]*?\}\)\.then\(async value => \{[\s\S]*?if \(!profileScopeIsCurrent\(scope\)\) return[\s\S]*?if \(!name \|\| name === folder \|\| folders\.includes\(name\)\) return[\s\S]*?await Promise\.all\(sessions[\s\S]*?updateSession\(session\.id, \{ folder: name \}, scope\.profileGeneration\)[\s\S]*?if \(!profileScopeIsCurrent\(scope\)\) return[\s\S]*?setFolderOrder\(movableFolders\.map\(entry => entry === folder \? name : entry\), scope\.profileGeneration\)[\s\S]*?setCollapsedFolders\(collapsedFolders\.map\(entry => entry === folder \? name : entry\), scope\.profileGeneration\)/)
})

test('closed chat rows fully cover their action surfaces', () => {
  assert.match(source, /backgroundColor: selected \? colors\.selected : pressed \? colors\.raised : colors\.background/)
  assert.match(source, /session: \{ minHeight: 51,[^}]*overflow: 'hidden' \}/)
  assert.match(source, /sessionInShell: \{ flex: 1 \}/)
})

test('ordinary chat selection opens the pane before timeline synchronization settles', () => {
  assert.match(source, /const selection = select\(session\.id, profileScope\.profileGeneration\)[\s\S]*?useAppStore\.getState\(\)\.selectedSessionId === session\.id[\s\S]*?onOpenChat\?\.\(\)[\s\S]*?void selection/)
  assert.doesNotMatch(source, /select\(session\.id, profileScope\.profileGeneration\)\.then\([\s\S]*?onOpenChat/)
})

test('selected chat has a persistent visual indicator', () => {
  assert.match(source, /selected \? <View pointerEvents="none" style=\{\[styles\.selectedIndicator/)
  // Zed marks the selected row with --surface-3 rather than an accent outline.
  assert.match(source, /backgroundColor: selected \? colors\.selected :/)
})

test('provider requests waiting for the user are unmistakable without polling', () => {
  assert.match(source, /const waitingSessionCount = useMemo\(\(\) => sessions\.filter\(sessionNeedsProviderInteraction\)\.length, \[sessions\]\)/)
  assert.match(source, /waiting \? `\$\{runtimeSummary\(session\)\} · waiting for you`/)
  assert.match(source, /const waitingProviderName = session\.backend === 'claude' \? 'Claude' : 'Codex'/)
  assert.match(source, /accessibilityLabel=\{`\$\{pendingInteractionCount\} \$\{waitingProviderName\} \$\{pendingInteractionCount === 1 \? 'request' : 'requests'\} waiting for you`\}/)
  assert.match(source, /style=\{\[styles\.waitingBadge, \{ backgroundColor: colors\.orange \}\]\}/)
  assert.match(source, />\{waitingSessionCount\} waiting<\/Text>/)
  assert.doesNotMatch(source, /setInterval|setTimeout\([^)]*codex|pollCodex/i)
})

test('renaming a chat is offered on both platforms and shares one prompt/update path', () => {
  assert.match(source, /const requestRename = \(\) => \{[\s\S]*?promptText\(\{[\s\S]*?title: 'Rename Chat',[\s\S]*?initialValue: session\.title,[\s\S]*?confirmLabel: 'Rename',[\s\S]*?\}\)\.then\(value => \{[\s\S]*?if \(!sessionScopeIsCurrent\(scope, session\.id\)\) return[\s\S]*?const name = value\?\.trim\(\)[\s\S]*?if \(name && name !== session\.title\) void update\(session\.id, \{ title: name \}, scope\.profileGeneration\)/)
  assert.match(source, /else if \(id === 'rename'\) requestRename\(\)/)
  assert.match(source, /\{ id: 'rename', title: 'Rename Chat', image: 'pencil' \}/)
  assert.match(source, /\{ id: 'rename', title: 'Rename Chat' \}/)
  assert.match(source, /promptText: \(options: TextPromptOptions\) => Promise<string \| null>/)
})
