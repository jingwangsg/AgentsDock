import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
// The library's parser chain is plain JS, so the test drives the real AST
// pipeline; markdown-it is its nested dependency, reachable only through it.
import parser from 'react-native-markdown-display/src/lib/parser'
import type { Palette } from '../theme'
import {
  MARKDOWN_TABLE_MAX_COLUMN_WIDTH,
  MARKDOWN_TABLE_MIN_COLUMN_WIDTH,
  createMarkdownStyle,
  installMarkdownTableSource,
  markdownTableColumnWidths,
  markdownTableSource,
} from './markdown'
import { scaleChatFont } from './typography'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const lightPalette: Palette = {
  background: '#f6f7f8', surface: '#ffffff', raised: '#eef0f2', border: '#d9dce1',
  text: '#18191b', muted: '#686b72', blue: '#0879f9', green: '#168c4b',
  red: '#d92d38', orange: '#c66b14', yellow: '#8d7200', user: '#dff5e7', queued: '#fff6cf',
}
const darkPalette: Palette = {
  background: '#101112', surface: '#18191b', raised: '#202225', border: '#2b2d31',
  text: '#f4f4f5', muted: '#9a9ca2', blue: '#2f8cff', green: '#28c76f',
  red: '#ff5d64', orange: '#ff9f43', yellow: '#e2bd38', user: '#163f2a', queued: '#3a3214',
}

const lightStyle = createMarkdownStyle(lightPalette, 1)
assert(lightStyle.code_block?.backgroundColor === lightPalette.raised, 'light code blocks must use the light raised surface')
assert(lightStyle.fence?.backgroundColor === lightPalette.raised, 'light fenced blocks must use the light raised surface')
assert(lightStyle.code_inline?.color === lightPalette.text, 'light inline code must remain readable')
assert(lightStyle.list_item?.width === '100%', 'list rows must own a bounded width')
assert(lightStyle.ordered_list_content?.minWidth === 0, 'ordered-list content must be allowed to shrink below its intrinsic width')
assert(lightStyle.bullet_list_content?.minWidth === 0, 'bullet-list content must be allowed to shrink below its intrinsic width')
assert(lightStyle.textgroup?.width === '100%', 'selectable Markdown text must measure against its rendered slot')
assert(lightStyle.textgroup?.maxWidth === '100%', 'selectable Markdown text must not overflow an indented list slot')
assert(lightStyle.table?.marginBottom === 0, 'the horizontal table wrapper must own block spacing')

// Mirrors react-native-markdown-display's AST: cells wrap a textgroup of text
// and code_inline nodes; markdown-it pads short rows to the header's column count.
const cell = (type: 'th' | 'td', ...runs: Array<[string, string]>) => ({
  type,
  children: [{ type: 'textgroup', children: runs.map(([kind, content]) => ({ type: kind, content })) }],
})
const row = (type: 'th' | 'td', ...texts: string[]) => ({ type: 'tr', children: texts.map(text => cell(type, ['text', text])) })
const table = (...rows: object[]) => ({ type: 'table', children: [{ type: 'thead', children: rows.slice(0, 1) }, { type: 'tbody', children: rows.slice(1) }] })

const portTable = table(
  row('th', '本地端口', '远端目标', '实测状态'),
  { type: 'tr', children: [cell('td', ['text', '7850']), cell('td', ['code_inline', 'jing-debug-1e47:7850']), cell('td', ['text', '已验证（curl 200）'])] },
  row('td', '7851', 'osmo:7851', ''),
)
const portWidths = markdownTableColumnWidths(portTable, 1)
assert(portWidths.length === 3, 'table layout must produce one width per header column')
assert(portWidths[0] === MARKDOWN_TABLE_MIN_COLUMN_WIDTH, 'short cells keep the readable minimum column width')
assert(portWidths[1] === 20 * 10 + 12, 'a column must fit its longest unbreakable token plus cell padding so words never split mid-token')
assert(portWidths[2] === 18 * 10 + 12, 'wide CJK glyphs count double so mixed-script cells fit on one line')
assert(
  markdownTableColumnWidths(portTable, 1.2)[1] === scaleChatFont(20 * 10 + 12, 1.2),
  'table column width must respect the mobile font scale',
)
assert(markdownTableColumnWidths({ type: 'table', children: [] }, 1).length === 1, 'empty tables need a safe minimum layout column')

const [proseWidth, tokenWidth, hugeWidth] = markdownTableColumnWidths(table(row('th', 'a', 'b', 'c'), row(
  'td',
  'one two three four five six seven eight nine ten eleven twelve',
  'x'.repeat(30),
  'y'.repeat(40),
)), 1)
assert(proseWidth === 240 + 12, 'multi-word cells wrap at spaces instead of stretching the column to one line')
assert(tokenWidth === 30 * 10 + 12 && tokenWidth > proseWidth, 'a single long token widens the column past the wrap point rather than splitting mid-word')
assert(hugeWidth === MARKDOWN_TABLE_MAX_COLUMN_WIDTH, 'pathological cells must keep a bounded column width')

const darkStyle = createMarkdownStyle(darkPalette, 1)
assert(darkStyle.code_block?.backgroundColor === darkPalette.raised, 'dark code blocks must follow the active palette')
assert(darkStyle.body?.color === darkPalette.text, 'dark Markdown text must remain readable')

const scaledStyle = createMarkdownStyle(darkPalette, 1.2)
assert(
  Number(scaledStyle.paragraph?.fontSize) > Number(darkStyle.paragraph?.fontSize),
  'Markdown must respect the mobile chat font scale',
)

assert(JSON.stringify(darkStyle) === JSON.stringify(createMarkdownStyle(darkPalette, 1, false)), 'omitting compact must preserve the default Markdown styles')
assert(darkStyle.body?.fontSize === 15.5 && darkStyle.body?.lineHeight === 23, 'default body typography must remain unchanged')
assert(darkStyle.heading1?.fontSize === 23 && darkStyle.fence?.fontSize === 12.5, 'default heading and code typography must remain unchanged')
for (const scale of [0.8, 1, 1.2, 1.4]) {
  const compactStyle = createMarkdownStyle(darkPalette, scale, true)
  assert(compactStyle.body?.fontSize === scaleChatFont(12, scale), 'compact text must scale its own 12-point base with the original user preference')
  assert(compactStyle.body?.lineHeight === scaleChatFont(19, scale), 'compact line height must scale its own 19-point base')
  assert(compactStyle.paragraph?.fontSize === compactStyle.body?.fontSize, 'compact paragraphs must match body typography')
  assert(Number(compactStyle.heading1?.fontSize) > Number(compactStyle.heading2?.fontSize), 'compact heading hierarchy must remain visible')
  assert(Number(compactStyle.heading2?.fontSize) > Number(compactStyle.body?.fontSize), 'compact headings must remain larger than body text')
  assert(compactStyle.fence?.fontSize === scaleChatFont(11, scale), 'compact code must follow the original font scale')
  assert(compactStyle.fence?.lineHeight === scaleChatFont(16, scale), 'compact code needs readable line spacing')
  assert(compactStyle.th?.padding === 4 && compactStyle.td?.padding === 4, 'compact table cells must retain consistent padding')
  assert(compactStyle.textgroup?.width === '100%' && compactStyle.textgroup?.minWidth === 0, 'compact selectable text must retain bounded layout')
}
const compactTint = createMarkdownStyle({ ...lightPalette, text: '#503e68' }, 1, true)
assert(compactTint.body?.color === '#503e68' && compactTint.fence?.color === '#503e68', 'compact content must accept the conversation body color')
assert(compactTint.link?.color === lightPalette.blue, 'body tint must preserve distinguishable links')

// The chat parser stashes each table's own lines so the expanded view can
// re-parse one table through the same renderer.
const MarkdownIt = createRequire(realpathSync(resolve('node_modules/react-native-markdown-display/package.json')))('markdown-it')
const tableMarkdown = installMarkdownTableSource(new MarkdownIt({ typographer: true }))
type Node = { type: string; children?: Node[] }
const tablesIn = (source: string): Node[] => {
  const find = (nodes: Node[]): Node[] => nodes.flatMap(node => node.type === 'table' ? [node] : find(node.children ?? []))
  return find(parser(source, (ast: Node[]) => ast, tableMarkdown))
}
const [portTableNode] = tablesIn('Ports:\r\n\r\n| Port | Target |\r\n|---|---|\r\n| 7850 | `osmo:7850` |\r\n\r\nDone.')
assert(markdownTableSource(portTableNode!) === '| Port | Target |\n|---|---|\n| 7850 | `osmo:7850` |', 'a table carries exactly its own lines, with line breaks normalised')
const [firstTable, secondTable] = tablesIn('| a |\n|---|\n| 1 |\n\ntext\n\n| b | c |\n|---|---|\n| 2 | 3 |')
assert(markdownTableSource(firstTable!) === '| a |\n|---|\n| 1 |' && markdownTableSource(secondTable!) === '| b | c |\n|---|---|\n| 2 | 3 |', 'each table keeps its own source')
const nestedSource = markdownTableSource(tablesIn('1. Results:\n\n    | a | b |\n    |---|---|\n    | 1 | 2 |\n')[0]!)
assert(nestedSource === '| a | b |\n|---|---|\n| 1 | 2 |', 'a table nested in a list is dedented')
assert(tablesIn(nestedSource).length === 1 && tablesIn('    | a | b |\n    |---|---|\n    | 1 | 2 |').length === 0, 'dedenting is what lets the nested source re-parse as a table rather than a code block')

console.log('Markdown theme and typography regressions passed')
