import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const sheet = source('src/components/WorkspaceChanges.tsx')
const appShell = source('src/components/AppShell.tsx')
const inspector = source('src/components/Inspector.tsx')
const outputs = source('src/components/ChatOutputsPanel.tsx')
const chatScreen = source('src/components/ChatScreen.tsx')
const client = source('src/api/AgentServerClient.ts')
const helpers = source('src/lib/workspace-changes.ts')
const types = source('src/types.ts')

test('Changes is reachable from the chat details actions and the Outputs & sources sheet', () => {
  assert.match(inspector, /onChanges: \(\) => void/)
  assert.match(inspector, /<Command icon=\{FileDiff\} label="Changes" testID="inspector-changes" onPress=\{\(\) => \{ if \(scopeIsCurrent\(\)\) onChanges\(\) \}\} \/>/)
  assert.match(outputs, /onChanges: \(\) => void/)
  assert.match(outputs, /<Row icon=\{GitBranch\} label="Workspace changes" secondary="Git status and diffs of the working directory" onPress=\{\(\) => closeThen\(onChanges\)\} \/>/, 'the row waits for the sheet to dismiss like every other row action')
  assert.match(chatScreen, /onChanges: \(\) => void/)
  assert.match(chatScreen, /onReview=\{onReview\} onChanges=\{onChanges\} onOpenCanvas=\{setCanvasName\}/)
})

test('the app shell owns the sheet and routes both entry points through the inspector action handoff', () => {
  assert.match(appShell, /import \{ WorkspaceChanges \} from '\.\/WorkspaceChanges'/)
  assert.match(appShell, /kind: 'digest' \| 'job' \| 'terminal' \| 'processes' \| 'tmux' \| 'changes'/)
  assert.match(appShell, /const \[changes, setChanges\] = useState\(false\)/)
  assert.match(appShell, /else if \(kind === 'changes'\) setChanges\(true\)/)
  assert.match(appShell, /const closeChanges = useCallback\(\(\) => \{\s+setChanges\(false\)\s+requestAnimationFrame\(dismissAppKeyboard\)/)
  assert.match(appShell, /onReview=\{openReview\} onChanges=\{\(\) => openInspectorAction\('changes'\)\}/)
  // The inline inspector opens directly; the Chat details page sheet must dismiss first (same as terminal/tmux).
  assert.match(appShell, /onTmux=\{\(\) => openInspectorAction\('tmux'\)\} onChanges=\{\(\) => openInspectorAction\('changes'\)\}/)
  assert.match(appShell, /onTmux=\{\(\) => queueInspectorAction\('tmux'\)\} onChanges=\{\(\) => queueInspectorAction\('changes'\)\}/)
  assert.match(appShell, /<WorkspaceChanges sessionId=\{selected\?\.id \?\? ''\} visible=\{modalScopeCurrent && changes && Boolean\(selected\) && !isWelcomeSession\(selected\?\.id\)\} onClose=\{closeChanges\} \/>/)
})

test('the sheet uses the Review chrome and the same connection scoping', () => {
  assert.match(sheet, /<Modal key=\{connectionKey\} visible=\{visible\} animationType="slide" presentationStyle=\{Platform\.OS === 'ios' \? 'pageSheet' : 'fullScreen'\} allowSwipeDismissal onRequestClose=\{onClose\}>/)
  assert.match(sheet, /<SafeAreaView style=\{\[styles\.root, \{ backgroundColor: colors\.background \}\]\} edges=\{\['top', 'bottom'\]\}>/)
  assert.match(sheet, /header: \{ minHeight: 64/)
  assert.match(sheet, /<SheetCloseButton onPress=\{onClose\} label="Close changes" testID="changes-close" \/>/)
  assert.match(sheet, /const connectionReady = connected && !connecting && !switchingProfileId && connection\.isValidated/)
  assert.match(sheet, /import \{ connectionIsCurrent \} from '\.\/CodeReview'/)
  assert.match(sheet, /key=\{`\$\{connectionKey\}:\$\{props\.sessionId\}`\}/, 'a server or chat switch remounts the scoped sheet')
  assert.match(sheet, /if \(epoch !== statusEpoch\.current \|\| !isCurrent\(\)\) return/)
  assert.match(sheet, /\.then\(next => \{ if \(!cancelled && isCurrent\(\)\) setDetail\(next\) \}\)/)
  assert.match(sheet, /useEffect\(\(\) => \{ if \(visible && connectionReady\) void refresh\(\) \}, \[connectionReady, refresh, visible\]\)/, 'opening the sheet refetches')
})

test('the list offers filters with counts, search, bulk and per-file staging, and pull-to-refresh', () => {
  assert.match(helpers, /export const CHANGES_FILTERS: readonly ChangesFilter\[\] = \['all', 'staged', 'unstaged', 'untracked', 'conflicts'\]/)
  assert.match(sheet, /CHANGES_FILTERS\.filter\(group => group === 'all' \|\| group === filter \|\| counts\[group\] > 0\)/, 'zero-count groups hide except All and the active one')
  assert.match(sheet, /testID=\{`changes-filter-\$\{group\}`\}/)
  assert.match(sheet, /<TextInput value=\{query\} onChangeText=\{setQuery\} placeholder="Filter files"/)
  assert.match(sheet, /<BulkButton icon=\{Plus\} label="Stage all" disabled=\{blocked \|\| !stageable\.length\} onPress=\{\(\) => void run\('stage', stageable\)\}/)
  assert.match(sheet, /<BulkButton icon=\{Minus\} label="Unstage all" disabled=\{blocked \|\| !unstageable\.length\} onPress=\{\(\) => void run\('unstage', unstageable\)\}/)
  assert.match(sheet, /const blocked = busy \|\| loading/)
  assert.match(sheet, /refreshControl=\{<RefreshControl refreshing=\{loading\} onRefresh=\{\(\) => void refresh\(\)\}/)
  // Tree rows: directories toggle with a count; file rows show the leaf name, status letters and stage/unstage buttons.
  assert.match(sheet, /import \{ buildFileTree, [^}]*\} from '\.\.\/lib\/file-tree'/)
  assert.match(sheet, /accessibilityState=\{\{ expanded \}\} onPress=\{\(\) => onToggle\(node\.path\)\}/)
  assert.match(sheet, /const code = file\.conflicted \? '!' : `\$\{file\.index_status\}\$\{file\.worktree_status\}`/)
  assert.match(sheet, /const identity = file\.original_path \? `\$\{file\.original_path\} → \$\{file\.path\}` : file\.path/)
  assert.match(sheet, /\{fileHasView\(file, 'unstaged'\) \? <IconButton icon=\{Plus\} size=\{15\} disabled=\{blocked\}/)
  assert.match(sheet, /\{fileHasView\(file, 'staged'\) \? <IconButton icon=\{Minus\} size=\{15\} disabled=\{blocked\}/)
})

test('the diff pane renders through Monaco with the shared layout preference, and conflicts read-only', () => {
  assert.match(sheet, /import \{ MonacoDiffView \} from '\.\/MonacoDiffView'/)
  assert.match(sheet, /<MonacoDiffView file=\{file\} path=\{diff\.path\} sideBySide=\{sideBySide\} wordWrap=\{wordWrap\} gapLabel=\{gapLabel\} \/>/)
  assert.match(sheet, /^const gapLabel = \(unchanged: number \| null\) => /m)
  assert.match(sheet, /files\.find\(candidate => candidate\.path === diff\.path\) \?\? files\[0\] \?\? null/, 'the block matching the selected path wins, else the first')
  assert.match(sheet, /import \{ readReviewLayout, writeReviewLayout, type ReviewLayoutPreference \} from '\.\.\/lib\/review-layout-preference'/)
  assert.match(sheet, /const SPLIT_MIN_WIDTH = 700/)
  assert.match(sheet, /const split = workspaceWidth >= SPLIT_MIN_WIDTH/)
  assert.match(sheet, /const sideBySide = layout\.sideBySide \?\? split/)
  assert.match(sheet, /testID="changes-layout-toggle"/)
  assert.match(sheet, /<IconButton icon=\{WrapText\} selected=\{layout\.wordWrap\} onPress=\{toggleWordWrap\} label="Wrap long lines" testID="changes-word-wrap" \/>/)
  // Phones swap the list for the diff and offer a back button; tablets keep both.
  assert.match(sheet, /\{!split && selection \? <IconButton icon=\{ArrowLeft\} onPress=\{\(\) => setSelection\(null\)\} label="Back to changed files" testID="changes-back" \/> : null\}/)
  assert.match(sheet, /\{split \|\| !selection \? <ScrollView/)
  assert.match(sheet, /\{split \|\| selection \? <View style=\{styles\.detail\}>/)
  // Staged/Unstaged switch only when the file has both sides.
  assert.match(sheet, /fileHasView\(selectedFile, 'staged'\) && fileHasView\(selectedFile, 'unstaged'\) \? <View style=\{\[styles\.segmented/)
  for (const copy of ['Binary file: no text diff to show.', 'No diff to show for this view.', 'bounded preview', 'Unresolved conflict, shown read-only.']) {
    assert.ok(sheet.includes(copy), `sheet must render ${JSON.stringify(copy)}`)
  }
  assert.match(sheet, /testID="changes-conflict-view"/)
  assert.doesNotMatch(sheet, /action: 'resolve'|action: 'commit'|action: 'continue'|action: 'abort'/, 'mobile only stages and unstages')
})

test('errors are a dismissible banner, a stale stage retries once, and a non-Git workspace is a plain state', () => {
  assert.match(sheet, /\{error \? <View accessibilityRole="alert"[\s\S]*?<IconButton icon=\{X\} size=\{15\} onPress=\{\(\) => setError\(null\)\} label="Dismiss error" testID="changes-dismiss-error" \/>/)
  assert.doesNotMatch(sheet, /Alert\.alert/)
  assert.match(sheet, /const NOT_GIT_MESSAGE = "This chat's working directory is not inside a Git repository\."/)
  assert.match(sheet, /if \(gitErrorCode\(reason\) === 'workspace_not_git'\) \{ setNotGit\(true\)/)
  assert.match(sheet, /\{notGit \? <Notice text=\{NOT_GIT_MESSAGE\} testID="changes-not-git" \/>/)
  // The action result is the next status; on failure one read reconciles.
  assert.match(sheet, /const next = await connection\.workspaceGitAction\(sessionId, \{ action, paths, expected_revision: status\.revision \}\)/)
  assert.match(sheet, /setError\(errorText\(reason\)\)\s+\/\/[^\n]*\n\s+void refresh\(\)/)
  assert.match(client, /if \(!retriesStaleGitAction\(input\.action, error\)\) throw error\s+const current = await this\.workspaceGitStatus\(sessionId\)\s+return post\(\{ \.\.\.input, expected_revision: current\.revision \}\)/)
  assert.match(client, /workspace\/git\/diff\?path=\$\{encodeURIComponent\(path\)\}&view=\$\{view\}`, \{\}, 40_000, false, 'native-control'\)/)
  assert.match(client, /workspace\/git\/conflict\?path=\$\{encodeURIComponent\(path\)\}`, \{\}, 40_000, false, 'native-control'\)/)
  assert.match(client, /workspace\/git\/action`, \{\s+method: 'POST', body: JSON\.stringify\(action\),\s+\}, 120_000, false, 'native-control'\)/)
  assert.match(helpers, /gitErrorCode\(error\) === 'git_stale_revision'/)
  assert.match(types, /export interface WorkspaceGitFile \{\s+path: string\s+original_path\?: string\s+index_status: string\s+worktree_status: string\s+staged: boolean\s+unstaged: boolean\s+untracked: boolean\s+conflicted: boolean\s+\}/)
})
