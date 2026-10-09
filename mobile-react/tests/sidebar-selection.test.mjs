import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = fs.readFileSync(path.resolve('src/components/Sidebar.tsx'), 'utf8')

test('sidebar list explicitly invalidates recycled rows when selection changes', () => {
  assert.match(source, /const listState = useMemo\(\(\) => \(\{ active, selected, openingSearchResultId \}\)/)
  assert.match(source, /<DraggableFlatList[\s\S]*?extraData=\{listState\}/)
  assert.match(source, /accessibilityState=\{\{ selected, disabled: opening \}\}/)
})

test('chat taps on both platforms stay on a plain native press target', () => {
  const rowPress = source.match(/const pressableRow = \(([\s\S]*?)\n  \)\n  \/\/ The chat identity/)?.[1] ?? ''
  assert.match(rowPress, /if \(!sessionScopeIsCurrent\(profileScope, session\.id\)\) return[\s\S]*?onPress\(\)/)
  assert.match(source, /onLongPress=\{welcome \? undefined : \(\) => onLift\(Platform\.OS === 'ios' \? openActionSheet : \(\) => menu\.current\?\.show\(\)\)\}/)
  assert.match(source, /if \(welcome \|\| Platform\.OS === 'ios'\) return pressableRow/)
  assert.doesNotMatch(source, /from 'react-native-gesture-handler\/ReanimatedSwipeable'|<ReanimatedSwipeable|SwipeableMethods/)
  assert.doesNotMatch(source, /<MenuView[^>]*>\{pressableRow\}<\/MenuView>/)
})

test('folder headers show their chats\' status dots between the title and the count', () => {
  // One dot per kind present (waiting, running, unread), so a collapsed folder still says where to look.
  // The dots come from renderItem: the rows memo must not depend on `active` (it changes every health poll
  // and the rows' identity holds a dropped order).
  assert.match(source, /<FolderHeader\s*item=\{item\}\s*status=\{query\.trim\(\) \? \[\] : folderStatusKinds\(item\.sessions, active\)\}/)
  assert.match(source, /\{item\.title\}<\/Text>\s*\{status\.map\(kind => <View key=\{kind\} style=\{\[styles\.headerStatusDot, \{ backgroundColor: kind === 'waiting' \? colors\.orange : kind === 'running' \? colors\.green : colors\.blue \}\]\} \/>\)\}\s*<Text style=\{\[styles\.count/)
  assert.match(source, /\}, \[collapsed, folderOrder, query, searchResults, sessions, surfaces, selected\]\)/)
})

test('Android chat and folder actions open from a long press on a collapsed sibling anchor', () => {
  assert.match(source, /<View style=\{styles\.sessionShell\}>\{pressableRow\}<MenuView ref=\{menu\} testID=\{`chat-actions-\$\{session\.id\}`\}/)
  assert.match(source, /<View style=\{styles\.folderHeaderShell\}>\{header\}<MenuView ref=\{menu\} testID=\{`folder-actions-\$\{item\.folder\}`\}/)
  assert.match(source, /onLongPress=\{!hasMenu \? undefined : \(\) => onLift\(Platform\.OS === 'ios' \? openActionSheet : \(\) => menu\.current\?\.show\(\)\)\}/)
  assert.match(source, /menuAnchor: \{ width: 0, justifyContent: 'flex-end', pointerEvents: 'none' \}/)
  // Compose only tracks a drawn (non-zero) anchor, so the trigger keeps a 1pt child.
  assert.match(source, /menuAnchorContent: \{ width: 1, height: 1 \}/)
  // Every sidebar menu (chat, folder, tab) opens from the collapsed anchor rather than wrapping its row.
  assert.equal(source.match(/style=\{styles\.menuAnchor\}><View style=\{styles\.menuAnchorContent\} \/><\/MenuView>/g)?.length, source.match(/<MenuView ref=\{menu\}/g)?.length)
  assert.doesNotMatch(source, /MoreHorizontal|AndroidMoreMenu/)
})

test('folder menus offer a new chat per backend that can start on this host, in that folder, on both platforms', () => {
  // The server supports Cursor everywhere; the menu lists it only while this host's Cursor CLI is ready.
  assert.match(source, /const chatBackends = useMemo\(\(\) => readyChatBackends\(health, runtime\), \[health, runtime\]\)/)
  assert.match(source, /\.\.\.backends\.map\(backend => \(\{ id: `new:\$\{backend\}`, title: `New \$\{backendLabel\(backend\)\} chat`, image: 'plus' \} satisfies MenuAction\)\),/)
  assert.match(source, /const backend = backends\.find\(value => id === `new:\$\{value\}`\)\s*if \(backend\) onNewChat\(backend\)/)
  assert.match(source, /onNewChat=\{backend => onNewChatIn\(item\.folder, backend\)\}/)
  assert.doesNotMatch(source, /new-claude|new-codex/)
})

test('every folder, General included, shows the same menu on both platforms', () => {
  // The iOS sheet is derived from the Android action list, so the two cannot drift.
  assert.match(source, /options: \[\.\.\.actions\.map\(action => action\.title\), 'Cancel'\],\s*cancelButtonIndex: actions\.length,\s*destructiveButtonIndex: actions\.findIndex\(action => action\.attributes\?\.destructive\),/)
  assert.match(source, /\{ id: 'rename', title: 'Rename Folder', image: 'pencil' \},\s*\.\.\.\(canMoveUp \? \[\{ id: 'move-up', title: 'Move Folder Up', image: 'arrow\.up' \} satisfies MenuAction\] : \[\]\),\s*\.\.\.\(canMoveDown \? \[\{ id: 'move-down', title: 'Move Folder Down', image: 'arrow\.down' \} satisfies MenuAction\] : \[\]\),\s*\{ id: 'delete', title: 'Delete Folder', image: 'trash', attributes: \{ destructive: true \} \},\s*\]/)
  // Only the virtual sections go without a menu; General is an ordinary folder.
  assert.match(source, /const hasMenu = !\['Pinned', 'Archived'\]\.includes\(item\.folder\)/)
  assert.doesNotMatch(source, /movable|'General', 'Archived'\]/)
  // Move Folder acts on the rendered folder list and hides at the edges instead of disabling.
  assert.match(source, /const folders = useMemo\(\(\) => orderedSessionSections\(sessions, folderOrder, false, true\)\.map\(section => section\.id\)\.filter\(folder => folder !== 'Pinned'\), \[folderOrder, sessions\]\)/)
  assert.match(source, /canMoveUp=\{folders\.indexOf\(item\.folder\) > 0\}\s*canMoveDown=\{folders\.indexOf\(item\.folder\) >= 0 && folders\.indexOf\(item\.folder\) < folders\.length - 1\}/)
  assert.doesNotMatch(source, /Move Folder (Up|Down)', image: '[^']*', attributes: \{ disabled/)
})

test('renaming a folder moves its chats, then renames the order and collapsed entries', () => {
  assert.match(source, /else if \(id === 'rename'\) onRename\(\)/)
  assert.match(source, /onRename=\{\(\) => renameFolder\(item\.folder\)\}/)
  // Refuses empty/unchanged names and case-insensitive duplicates of another folder; matches chats by effective folder so General's empty-field chats move too.
  assert.match(source, /const renameFolder = \(folder: string\) => \{[\s\S]*?promptText\(\{[\s\S]*?title: 'Rename folder',[\s\S]*?initialValue: folder,[\s\S]*?confirmLabel: 'Rename',[\s\S]*?\}\)\.then\(async value => \{[\s\S]*?if \(!profileScopeIsCurrent\(scope\)\) return[\s\S]*?if \(!name \|\| name === folder \|\| folders\.some\(entry => entry !== folder && entry\.toLowerCase\(\) === name\.toLowerCase\(\)\)\) return[\s\S]*?await Promise\.all\(sessions[\s\S]*?\(session\.folder\?\.trim\(\) \|\| 'General'\) === folder\)[\s\S]*?updateSession\(session\.id, \{ folder: name \}, scope\.profileGeneration\)[\s\S]*?if \(!profileScopeIsCurrent\(scope\)\) return[\s\S]*?setFolderOrder\(folders\.map\(entry => entry === folder \? name : entry\), scope\.profileGeneration\)[\s\S]*?setCollapsedFolders\(collapsedFolders\.map\(entry => entry === folder \? name : entry\), scope\.profileGeneration\)/)
})

test('deleting a folder sends its chats to General, else the first other folder, without a confirmation prompt', () => {
  assert.match(source, /else if \(id === 'delete'\) onDelete\(\)/)
  assert.match(source, /onDelete=\{\(\) => deleteFolder\(item\.folder\)\}/)
  const deleteFolder = source.match(/const deleteFolder = \(folder: string\) => \{([\s\S]*?)\n  \}\n/)?.[1] ?? ''
  assert.match(deleteFolder, /const others = folders\.filter\(entry => entry !== folder\)/)
  assert.match(deleteFolder, /const destination = others\.includes\('General'\) \? 'General' : others\.length \? others\[0\] : folder === 'General' \? null : 'General'/)
  assert.match(deleteFolder, /if \(!destination && moving\.length\) \{\s*Alert\.alert\('Create another folder first', `The chats in “\$\{folder\}” need somewhere to go\.`\)\s*return\s*\}/)
  assert.match(deleteFolder, /updateSession\(session\.id, \{ folder: destination \}, scope\.profileGeneration\)/)
  assert.match(deleteFolder, /setFolderOrder\(others, scope\.profileGeneration\)[\s\S]*?setCollapsedFolders\(collapsedFolders\.filter\(entry => entry !== folder\), scope\.profileGeneration\)/)
  assert.doesNotMatch(deleteFolder, /promptText|Alert\.alert\('Delete/)
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
  assert.match(source, /waiting \? `\$\{runtimeSummary\(session, runtime\)\} · waiting for you`/)
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

test('Archived starts collapsed on every launch and its expansion is not persisted', () => {
  assert.match(source, /const \[archivedExpanded, setArchivedExpanded\] = useState\(false\)/)
  assert.match(source, /if \(!archivedExpanded\) next\.add\('Archived'\)/)
  // Toggling Archived flips session state instead of writing the persisted collapsed list.
  assert.match(source, /if \(item\.folder === 'Archived'\) \{ setArchivedExpanded\(expanded => !expanded\); return \}/)
  assert.match(source, /next\.delete\('Archived'\)/)
})

test('a long press lifts a chat or folder for dragging and still opens its menu when let go in place', () => {
  assert.equal(source.match(/onLift=\{openMenu => lift\(openMenu, drag\)\}/g)?.length, 3)
  // Tab rows lift like chats, and every row offers a grip that lifts it at once.
  assert.match(source, /onLongPress=\{\(\) => onLift\(Platform\.OS === 'ios' \? openActionSheet : \(\) => menu\.current\?\.show\(\)\)\}/)
  assert.equal(source.match(/<DragHandle onDragStart=\{onDragStart\} \/>/g)?.length, 2)
  assert.match(source, /onPressIn=\{onDragStart\}/)
  assert.match(source, /if \(from === to\) \{ openMenu\?\.\(\); return \}/)
  assert.match(source, /onPlaceholderIndexChange=\{\(\) => \{ liftedMenu\.current = null \}\}/)
})

test('the draggable-flatlist patch is registered: a lifted row stays put until the pan gesture moves it, and a release in place resets the drag', () => {
  // Unpatched, a row lifted within 30 dp of the list edge (a long press on the last
  // visible row) scrolled the list at once: the row drifted, its menu was cancelled
  // and a release dropped it elsewhere.
  const workspace = fs.readFileSync(path.resolve('pnpm-workspace.yaml'), 'utf8')
  assert.match(workspace, /react-native-draggable-flatlist@4\.0\.3: patches\/react-native-draggable-flatlist@4\.0\.3\.patch/)
  const patch = fs.readFileSync(path.resolve('patches/react-native-draggable-flatlist@4.0.3.patch'), 'utf8')
  assert.match(patch, /^\+\s+const dragIsMoving = panGestureState\.value === GestureState\.ACTIVE;$/m)
  assert.match(patch, /^\+\s+cellIsActive &&\n\+\s+dragIsMoving\n/m)
  // Before the finger moves, a lifted row cut off by the edge is not constrained into view either.
  assert.match(patch, /^\+\s+isTouchActiveNative\.value &&\n\+\s+panGestureState\.value === GestureState\.ACTIVE\n\+\s+\? constrained - activeCellOffset\.value/m)
  // A release in place resets the drag state, or the next lift reports a stale placeholder change and loses its menu.
  assert.match(patch, /^\+\s+if \(from === to\) reset\(\);$/m)
})

test('a refused drop is drawn once, then undone, and a held order lasts only for its rows', () => {
  // draggable-flatlist resets a dropped row only when the key order changes.
  assert.match(source, /setDropped\(\{ base: rows, data, refused: !drop \}\)\s*if \(!drop\) return/)
  assert.match(source, /if \(!dropped\?\.refused\) return\s*const undo = setImmediate\(\(\) => setDropped\(null\)\)/)
  assert.match(source, /const listData = dropped\?\.base === rows \? dropped\.data : rows/)
})

test('a dropped tab reorders among tabs and moves to the folder above it', () => {
  assert.match(source, /if \(moved\.kind === 'surface'\) \{/)
  assert.match(source, /const ids = data\.flatMap\(row => row\.kind === 'surface' \? \[row\.surface\.id\] : \[\]\)/)
  assert.match(source, /orderChanged \? reorderSurfaces\(ids, profileScope\.profileGeneration\)/)
  assert.match(source, /folderChanged \? updateSurface\(moved\.surface\.id, \{ folder \}, profileScope\.profileGeneration\)/)
})
