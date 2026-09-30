import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function source(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}

const header = source('src/components/ChatHeader.tsx')
const chatScreen = source('src/components/ChatScreen.tsx')
const panel = source('src/components/ChatOutputsPanel.tsx')
const collector = source('src/lib/chat-outputs.ts')
const types = source('src/types.ts')
const store = source('src/store/useAppStore.ts')

test('the header exposes an Outputs & sources toggle beside the Files button', () => {
  assert.match(header, /import \{ [^}]*\bLayers\b[^}]* \} from 'lucide-react-native'/)
  assert.match(header, /<IconButton icon=\{Layers\} onPress=\{onOutputs\} selected=\{outputsOpen\} label="Outputs and sources" testID="chat-outputs" \/>/)
  assert.ok(
    header.indexOf('testID="chat-workspace-files"') < header.indexOf('testID="chat-outputs"')
    && header.indexOf('testID="chat-outputs"') < header.indexOf('onPress={onToggleInspector}'),
    'the outputs toggle sits between Files and the inspector toggle',
  )
  assert.match(chatScreen, /outputsOpen=\{outputsOpen\} onOutputs=\{\(\) => \{ dismissAppKeyboard\(\); setOutputsOpen\(true\) \}\}/)
  assert.match(chatScreen, /\{!welcome \? <ChatOutputsPanel sessionId=\{sessionId\} visible=\{outputsOpen\} onClose=\{\(\) => setOutputsOpen\(false\)\} onReview=\{onReview\} onChanges=\{onChanges\} onOpenCanvas=\{setCanvasName\} \/> : null\}/)
})

test('the panel is a page sheet like Chat details and follows the desktop copy', () => {
  assert.match(panel, /<Modal visible=\{visible\} animationType="slide" presentationStyle=\{Platform\.OS === 'ios' \? 'pageSheet' : 'fullScreen'\} allowSwipeDismissal onRequestClose=\{onClose\} onDismiss=\{finishDismissal\}>/)
  assert.match(panel, /<SheetCloseButton onPress=\{onClose\} label="Close outputs and sources" testID="chat-outputs-close" \/>/)
  for (const copy of ['Outputs & sources', '>Outputs<', '>Sources<', 'No outputs yet', 'No sources yet', "'Generated image'", '`${extension.toUpperCase()} file`', 'label="Local preview"', 'label="Web search"', 'label="Web pages"', 'secondary="Skill"', 'secondary="Referenced chat"', 'secondary="Attached to this chat"', '`View all (${sources.length})`', "'Show less'"]) {
    assert.ok(panel.includes(copy), `panel must render ${copy}`)
  }
  assert.match(panel, /`Edited \$\{plural\(item\.filesChanged, 'file', 'files'\)\}`/)
  assert.match(panel, /plural\(item\.count, 'use', 'uses'\)/)
  assert.match(panel, /`Searched \$\{plural\(item\.count, 'time', 'times'\)\}`/)
  assert.match(panel, /`Opened \$\{plural\(item\.count, 'page', 'pages'\)\}`/)
  assert.match(panel, /const COLLAPSED_SOURCE_ROWS = 6/)
  // Bounded history: the footer says what the aggregate covers.
  assert.match(panel, /\{hasMore \? <Text testID="chat-outputs-truncated"[\s\S]*?Older history is not included\./)
})

test('the panel aggregates the store events immediately on open and debounces later batches by 1 s', () => {
  assert.match(panel, /const REFRESH_DEBOUNCE_MS = 1_000/)
  assert.match(panel, /setTimeout\(\(\) => setSummary\(collectChatOutputs\(events, canvases\)\), firstLoad\.current \? 0 : REFRESH_DEBOUNCE_MS\)/)
  assert.match(panel, /\}, \[canvases, events, visible\]\)/)
  assert.match(collector, /export function collectChatOutputs\(events: readonly Event\[\], canvases: readonly CanvasSummary\[\] = \[\]\): ChatOutputsSummary/)
  assert.match(collector, /kind: 'canvas', label: canvasLinkText\.get\(canvas\.name\) \?\? canvas\.name, name: canvas\.name, path: canvas\.path/, 'canvas rows lead the outputs like the desktop')
  assert.match(types, /skill_selection\?: ProviderCommandSelection \| null/)
})

test('row actions defer to the sheet dismissal and reuse existing surfaces', () => {
  // Every action that presents another surface waits for this sheet to dismiss.
  assert.match(panel, /const closeThen = useCallback\(\(action: \(\) => void\) => \{[\s\S]*?pendingAction\.current = action[\s\S]*?onClose\(\)[\s\S]*?requestAnimationFrame\(finishDismissal\)[\s\S]*?setTimeout\(finishDismissal, IOS_DISMISS_FALLBACK_MS\)/)
  assert.match(panel, /closeThen\(\(\) => openArtifacts\(\{ sessionId, files: \[file\], initialId: file\.id, ownerKey: `chat-outputs:\$\{file\.id\}` \}\)\)/)
  assert.match(panel, /onPress=\{\(\) => void Linking\.openURL\(item\.url\)\}/)
  assert.match(panel, /onPress=\{runId \? \(\) => closeThen\(\(\) => onReview\(runId\)\) : undefined\}/)
  assert.match(panel, /closeThen\(\(\) => void seekTimelineResult\(\{ session_id: sessionId, event_id: event\.id, seq: event\.seq, role: 'trace', snippet: '' \}, profileGeneration\)\)/)
  assert.equal((panel.match(/onPress=\{\(\) => jumpTo\(item\.eventId\)\}/g) ?? []).length, 6, 'every source kind jumps to its earliest event')
  const row = panel.slice(panel.indexOf('function Row('), panel.indexOf('const styles = StyleSheet.create('))
  assert.doesNotMatch(row, /<Modal\b/, 'rows render inside the owning sheet')
  assert.match(row, /accessibilityState=\{\{ disabled: !onPress \}\}/)
})

test('a rewind carries the reverted-output counts and refreshes the files list', () => {
  assert.match(types, /outputs_reverted\?: \{ canvases: number; artifacts: number \} \| null/)
  const rewind = store.slice(store.indexOf('  async rewindSession(sessionId, runId, expectedGeneration, toSeq) {'), store.indexOf('  async restoreCheckpoint('))
  assert.match(rewind, /void get\(\)\.refreshSessions\(scope\.generation\)\s+void get\(\)\.refreshFiles\(sessionId, false, scope\.generation\)/)
  const rewindSnapshot = store.slice(store.indexOf('function rewindSnapshot('), store.indexOf('function sessionBusyForRewind('))
  assert.match(rewindSnapshot, /const files = snapshot\.files\.filter\(file => \{\s+const seq = file\.seq \?\? file\.event_seq\s+return seq == null \|\| seq < fromSeq! \|\| seq > throughSeq!/)
  assert.match(store, /return get\(\)\.rewindSession\(sessionId, runId, scope\.generation\)/, 'restoreCheckpoint funnels through rewindSession and inherits the refresh')
})
