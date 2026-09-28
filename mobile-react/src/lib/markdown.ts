import type { Palette } from '../theme'
import { fonts, scaleChatFont } from './typography'

export const MARKDOWN_TABLE_MIN_COLUMN_WIDTH = 112
export const MARKDOWN_TABLE_MAX_COLUMN_WIDTH = 320
// Multi-word cells wrap once their one-line width passes this point; a single
// unbreakable token may still widen the column up to the maximum.
const MARKDOWN_TABLE_WRAP_WIDTH = 240
// Body glyphs average ~0.55em of the 15.5pt font; 0.65em keeps digit- and
// capital-heavy tokens such as `jing-debug-1e47:7850` on one line. Wide CJK
// glyphs count as two units.
const MARKDOWN_TABLE_UNIT_WIDTH = 10
const MARKDOWN_TABLE_CELL_PADDING = 12
const WIDE_CHARACTER = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

type MarkdownTableNode = {
  type?: unknown
  content?: unknown
  children?: readonly MarkdownTableNode[]
}

/**
 * Content-sized column widths, like the desktop HTML table: each column is as
 * wide as its longest cell (bounded) and never narrower than its longest word,
 * so cell text wraps only at spaces. One entry per column, at least one.
 */
export function markdownTableColumnWidths(node: MarkdownTableNode, fontScale: number): number[] {
  const widths: number[] = []

  const cellText = (candidate: MarkdownTableNode): string => {
    if (candidate.type === 'text' || candidate.type === 'code_inline') return typeof candidate.content === 'string' ? candidate.content : ''
    if (candidate.type === 'softbreak' || candidate.type === 'hardbreak') return ' '
    return candidate.children?.map(cellText).join('') ?? ''
  }
  const textUnits = (text: string): number => {
    let units = 0
    for (const character of text) units += WIDE_CHARACTER.test(character) ? 2 : 1
    return units
  }
  const visit = (candidate: MarkdownTableNode): void => {
    if (candidate.type !== 'tr') {
      candidate.children?.forEach(visit)
      return
    }
    candidate.children?.filter(child => child.type === 'th' || child.type === 'td').forEach((cell, column) => {
      const text = cellText(cell).trim()
      const line = Math.min(textUnits(text) * MARKDOWN_TABLE_UNIT_WIDTH, MARKDOWN_TABLE_WRAP_WIDTH)
      const longestWord = Math.max(0, ...text.split(/\s+/u).map(textUnits)) * MARKDOWN_TABLE_UNIT_WIDTH
      const width = Math.max(line, longestWord) + MARKDOWN_TABLE_CELL_PADDING
      widths[column] = Math.max(widths[column] ?? 0, Math.min(MARKDOWN_TABLE_MAX_COLUMN_WIDTH, Math.max(MARKDOWN_TABLE_MIN_COLUMN_WIDTH, width)))
    })
  }

  visit(node)
  if (widths.length === 0) widths.push(MARKDOWN_TABLE_MIN_COLUMN_WIDTH)
  return widths.map(width => scaleChatFont(width, fontScale))
}

interface MarkdownItCoreLike {
  core: {
    ruler: {
      push: (
        ruleName: string,
        rule: (state: { src: string; tokens: Array<{ type: string; map: [number, number] | null; meta: unknown }> }) => void,
      ) => void
    }
  }
}

/**
 * Keep each table's own Markdown on its token so the expanded table view can
 * re-parse just that table: react-native-markdown-display copies `meta`, not
 * `map`, into the AST. Dedented so a table nested in a list still parses as a
 * table on its own instead of an indented code block.
 */
export function installMarkdownTableSource<T extends MarkdownItCoreLike>(markdown: T): T {
  markdown.core.ruler.push('agentsdock_table_source', state => {
    let lines: string[] | null = null
    for (const token of state.tokens) {
      if (token.type !== 'table_open' || !token.map) continue
      // Core rules run after normalize, so every line break in `src` is `\n`.
      if (!lines) lines = state.src.split('\n')
      const rows = lines.slice(token.map[0], token.map[1])
      const indent = Math.min(...rows.map(row => row.length - row.trimStart().length))
      token.meta = { ...(token.meta as object | null), source: rows.map(row => row.slice(indent)).join('\n') }
    }
  })
  return markdown
}

export function markdownTableSource(table: { type?: unknown; sourceMeta?: unknown }): string {
  return (table.sourceMeta as { source: string }).source
}

export function createMarkdownStyle(colors: Palette, fontScale: number, compact = false): Record<string, Record<string, string | number>> {
  const bodySize = scaleChatFont(compact ? 12 : 15.5, fontScale)
  const bodyLineHeight = scaleChatFont(compact ? 19 : 23, fontScale)
  const codeSize = scaleChatFont(compact ? 11 : 12.5, fontScale)
  const codeLineHeight = scaleChatFont(compact ? 16 : 18, fontScale)
  const blockSpacing = compact ? 6 : 10

  return {
    body: {
      color: colors.text,
      fontFamily: fonts.ui,
      fontSize: bodySize,
      lineHeight: bodyLineHeight,
    },
    paragraph: {
      color: colors.text,
      fontSize: bodySize,
      lineHeight: bodyLineHeight,
      marginTop: 0,
      marginBottom: blockSpacing,
      minWidth: 0,
    },
    heading1: {
      color: colors.text,
      fontSize: scaleChatFont(compact ? 18 : 23, fontScale),
      lineHeight: scaleChatFont(compact ? 24 : 30, fontScale),
      fontWeight: '800',
      marginTop: compact ? 8 : 10,
      marginBottom: compact ? 6 : 8,
    },
    heading2: {
      color: colors.text,
      fontSize: scaleChatFont(compact ? 15 : 19, fontScale),
      lineHeight: scaleChatFont(compact ? 21 : 26, fontScale),
      fontWeight: '800',
      marginTop: compact ? 8 : 10,
      marginBottom: compact ? 5 : 7,
    },
    heading3: {
      color: colors.text,
      fontSize: scaleChatFont(compact ? 13.5 : 17, fontScale),
      lineHeight: scaleChatFont(compact ? 20 : 24, fontScale),
      fontWeight: '700',
      marginTop: compact ? 6 : 8,
      marginBottom: compact ? 4 : 6,
    },
    heading4: {
      color: colors.text,
      fontSize: bodySize,
      lineHeight: bodyLineHeight,
      fontWeight: '700',
      marginTop: compact ? 6 : 8,
      marginBottom: compact ? 4 : 6,
    },
    heading5: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight, fontWeight: '700' },
    heading6: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight, fontWeight: '700' },
    text: { color: colors.text, fontSize: bodySize, lineHeight: bodyLineHeight },
    // react-native-markdown-display places list content in a flex row. Without
    // an explicit shrinkable width, iOS can measure the selectable UITextView
    // against the unindented paragraph width and then render it in the narrower
    // list slot. UIKit responds by tail-truncating the final wrapped line even
    // though numberOfLines is unlimited.
    textgroup: { flexShrink: 1, minWidth: 0, maxWidth: '100%', width: '100%' },
    link: { color: colors.blue, textDecorationLine: 'underline' },
    strong: { color: colors.text },
    em: { color: colors.text },
    code_inline: {
      color: colors.text,
      backgroundColor: colors.raised,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 4,
      paddingHorizontal: 4,
      paddingVertical: 1,
      fontFamily: fonts.mono,
      fontSize: codeSize,
    },
    code_block: {
      color: colors.text,
      backgroundColor: colors.raised,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      padding: compact ? 8 : 10,
      fontFamily: fonts.mono,
      fontSize: codeSize,
      lineHeight: codeLineHeight,
      marginBottom: blockSpacing,
    },
    fence: {
      color: colors.text,
      backgroundColor: colors.raised,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 6,
      padding: compact ? 8 : 10,
      fontFamily: fonts.mono,
      fontSize: codeSize,
      lineHeight: codeLineHeight,
      marginBottom: blockSpacing,
    },
    blockquote: {
      backgroundColor: colors.raised,
      borderColor: colors.blue,
      borderLeftWidth: 3,
      paddingHorizontal: compact ? 8 : 10,
      marginBottom: blockSpacing,
    },
    list_item: { flexDirection: 'row', justifyContent: 'flex-start', minWidth: 0, width: '100%' },
    bullet_list_icon: { color: colors.muted, marginLeft: 8, marginRight: 8 },
    bullet_list_content: { flex: 1, flexShrink: 1, minWidth: 0 },
    ordered_list_icon: { color: colors.muted, marginLeft: 8, marginRight: 8 },
    ordered_list_content: { flex: 1, flexShrink: 1, minWidth: 0 },
    hr: {
      backgroundColor: colors.border,
      height: 1,
      marginTop: compact ? 6 : 8,
      marginBottom: compact ? 8 : 12,
    },
    table: {
      borderColor: colors.border,
      borderWidth: 1,
      marginBottom: 0,
    },
    tr: { borderBottomWidth: 1, borderColor: colors.border, flexDirection: 'row' },
    th: { flex: 1, padding: compact ? 4 : 6, backgroundColor: colors.raised },
    td: { flex: 1, padding: compact ? 4 : 6, backgroundColor: colors.surface },
  }
}
