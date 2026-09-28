import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const markdown = fs.readFileSync(path.resolve('src/components/MarkdownContent.tsx'), 'utf8')
const sheet = fs.readFileSync(path.resolve('src/components/MarkdownTableSheet.tsx'), 'utf8')
const lib = fs.readFileSync(path.resolve('src/lib/markdown.ts'), 'utf8')

test('every chat table carries an Expand table overlay in its top-right corner', () => {
  assert.match(markdown, /import \{ Maximize2 \} from 'lucide-react-native'/)
  const table = markdown.slice(markdown.indexOf('    table: (node, children, _parents, markdownStyles) =>'), markdown.indexOf('    th: (node, children, parents, markdownStyles)'))
  assert.match(table, /<View key=\{node\.key\} style=\{styles\.tableFrame\}>\s*<ScrollView\s+horizontal/)
  assert.match(table, /\{expandableTables \? \(\s*<View style=\{styles\.tableExpand\}>\s*<IconButton\s+icon=\{Maximize2\}\s+size=\{14\}\s+touchSize=\{30\}\s+label="Expand table"\s+testID="markdown-table-expand"\s+onPress=\{\(\) => setExpandedTable\(restoreInlineRouteMarkerText\(markdownTableSource\(node\), prepared\.markers\)\)\}/)
  assert.match(markdown, /tableExpand: \{ position: 'absolute', top: 0, right: 0 \}/)
  assert.match(markdown, /tableFrame: \{ width: '100%', marginBottom: 10 \}/, 'the frame owns the block spacing the scroll view used to own')
  assert.doesNotMatch(table, /<Modal\b|MarkdownTableSheet/, 'one sheet per MarkdownContent, not one per table')
})

test('the expanded table is a page sheet that re-renders the same table through MarkdownContent', () => {
  assert.match(markdown, /const chatMarkdown = installMarkdownTableSource\(installMathMarkdown\(new MarkdownIt/)
  assert.match(markdown, /const \[expandedTable, setExpandedTable\] = useState<string \| null>\(null\)/)
  assert.match(markdown, /expandableTables = true,/)
  // Mounted only while open: a collapsed table is never laid out a second time.
  assert.match(markdown, /\{expandedTable !== null \? \(\s*<MarkdownTableSheet onClose=\{\(\) => setExpandedTable\(null\)\}>\s*(?:\{\/\*[^]*?\*\/\}\s*)?<MarkdownContent value=\{expandedTable\} fontScale=\{Math\.max\(1, fontScale\)\} color=\{color\} expandableTables=\{false\} \/>/)
  assert.doesNotMatch(markdown, /<Modal\b/, 'the renderer holds no sheet chrome, so it stays outside the app-typography text rule')
  assert.equal((markdown.match(/new MarkdownIt\(/g) ?? []).length, 1, 'the sheet reuses the chat parser')
  assert.equal((markdown.match(/<Markdown /g) ?? []).length, 1, 'one renderer: the sheet mounts MarkdownContent itself')

  assert.match(sheet, /<Modal visible animationType="slide" presentationStyle=\{Platform\.OS === 'ios' \? 'pageSheet' : 'fullScreen'\} allowSwipeDismissal onRequestClose=\{onClose\}>/)
  assert.match(sheet, /import \{ Text \} from '\.\/AppText'/)
  assert.match(sheet, /<Text style=\{\[styles\.title, \{ color: colors\.text \}\]\}>Table<\/Text>/)
  assert.match(sheet, /<SheetCloseButton onPress=\{onClose\} label="Close table" testID="markdown-table-close" \/>/)
  assert.match(sheet, /<ScrollView maximumZoomScale=\{3\} contentContainerStyle=\{styles\.content\}>\{children\}<\/ScrollView>/)
  assert.match(sheet, /Android has no zoom here and relies on the table's own horizontal scroll/)
})

test('the table source travels on the markdown-it token instead of through a second parse of the message', () => {
  assert.match(lib, /export function installMarkdownTableSource</)
  assert.match(lib, /core\.ruler\.push\('agentsdock_table_source'/)
  assert.match(lib, /if \(token\.type !== 'table_open' \|\| !token\.map\) continue/)
  assert.match(lib, /export function markdownTableSource\(table: \{ type\?: unknown; sourceMeta\?: unknown \}\): string/)
})
