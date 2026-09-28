import { useCallback, useMemo, useState } from 'react'
import { UITextView as SelectableText } from '@bsky.app/react-native-uitextview'
import { Linking, ScrollView, StyleSheet, Text as NativeText, View, type TextStyle } from 'react-native'
import { Maximize2 } from 'lucide-react-native'
import markdownItCjkFriendly from 'markdown-it-cjk-friendly'
import Markdown, { MarkdownIt, type ASTNode, type RenderRules } from 'react-native-markdown-display'
import { SvgXml } from 'react-native-svg'

import type { ChatReference } from '../types'
import { createMarkdownStyle, installMarkdownTableSource, markdownTableColumnWidths, markdownTableSource } from '../lib/markdown'
import { installMathMarkdown } from '../lib/math-markdown'
import {
  inlineRouteReferenceIsInteractive,
  prepareInlineRouteMarkdown,
  restoreInlineRouteMarkerText,
  splitInlineRouteMarkerText,
  timelineChatReferenceIsRemote,
} from '../lib/timeline-inline-references'
import { openCanvasLink } from '../lib/canvas-links'
import { texToSvg } from '../lib/tex-svg'
import { scaleChatFont } from '../lib/typography'
import { usePalette } from '../theme'
import { MarkdownTableSheet } from './MarkdownTableSheet'
import { MermaidDiagram } from './MermaidDiagram'
import { IconButton } from './ui'

// markdownItCjkFriendly: CommonMark refuses `**…。**他` as bold because the
// closing `**` sits between CJK punctuation and a letter; models write this
// constantly. Same fix as the desktop's remark-cjk-friendly.
const chatMarkdown = installMarkdownTableSource(installMathMarkdown(new MarkdownIt({ typographer: true }).use(markdownItCjkFriendly)))
const EMPTY_CHAT_REFERENCES: readonly ChatReference[] = []
const inlineReferenceStyles = StyleSheet.create({ marker: { borderRadius: 4, fontWeight: '800' } })

export function MarkdownContent({
  value,
  fontScale = 1,
  compact = false,
  color,
  inlineChatReferences = EMPTY_CHAT_REFERENCES,
  sourceSessionId,
  onChatReferencePress,
  expandableTables = true,
}: {
  value: string
  fontScale?: number
  compact?: boolean
  color?: string
  inlineChatReferences?: readonly ChatReference[]
  sourceSessionId?: string
  onChatReferencePress?: (reference: ChatReference) => void
  expandableTables?: boolean
}) {
  const colors = usePalette()
  const textColor = color ?? colors.text
  const [expandedTable, setExpandedTable] = useState<string | null>(null)
  const markdownStyle = useMemo(
    () => createMarkdownStyle(color === undefined ? colors : { ...colors, text: color }, fontScale, compact),
    [colors, color, compact, fontScale],
  )
  const prepared = useMemo(
    () => prepareInlineRouteMarkdown(value, inlineChatReferences, sourceSessionId),
    [inlineChatReferences, sourceSessionId, value],
  )
  const defaultMathFontSize = scaleChatFont(compact ? 12 : 15.5, fontScale)
  const openLink = useCallback((url: string) => {
    if (openCanvasLink(url, sourceSessionId ?? null)) return false
    void Linking.openURL(url).catch(() => undefined)
    return false
  }, [sourceSessionId])
  // Cells render before their table, so cell and table rules share one lookup
  // instead of re-walking the table for every cell.
  const tableColumnWidths = useMemo(() => {
    const cache = new WeakMap<ASTNode, number[]>()
    return (table: ASTNode): number[] => {
      let widths = cache.get(table)
      if (!widths) cache.set(table, widths = markdownTableColumnWidths(table, fontScale))
      return widths
    }
  }, [fontScale])
  const markdownRules = useMemo<RenderRules>(() => ({
    // Fabric's built-in `Text selectable` only exposes a whole-paragraph Copy
    // command. UITextView provides the normal iOS range handles while keeping
    // each paragraph synchronously measured for FlashList. Inline native
    // attachments cannot live inside UITextView, so those uncommon blocks
    // retain the existing renderer instead of degrading math or images.
    textgroup: (node, children, _parents, styles) => {
      if (containsInlineAttachment(node)) {
        return <NativeText key={node.key} selectable style={styles.textgroup}>{children}</NativeText>
      }
      return (
        <SelectableText key={node.key} selectable uiTextView style={styles.textgroup}>
          {children}
        </SelectableText>
      )
    },
    strong: (node, children, _parents, styles) => (
      <SelectableText key={node.key} style={styles.strong}>{children}</SelectableText>
    ),
    em: (node, children, _parents, styles) => (
      <SelectableText key={node.key} style={styles.em}>{children}</SelectableText>
    ),
    s: (node, children, _parents, styles) => (
      <SelectableText key={node.key} style={styles.s}>{children}</SelectableText>
    ),
    link: (node, children, _parents, styles) => (
      <SelectableText
        key={node.key}
        style={styles.link}
        onPress={() => openLink(node.attributes.href)}
      >
        {children}
      </SelectableText>
    ),
    code_inline: (node, _children, _parents, styles, inheritedStyles) => (
      <SelectableText key={node.key} style={[inheritedStyles, styles.code_inline]}>
        {restoreInlineRouteMarkerText(node.content, prepared.markers)}
      </SelectableText>
    ),
    text: (node, _children, parents, styles, inheritedStyles) => {
      const hasMarker = prepared.markers.some(candidate => node.content.includes(candidate.marker))
      if (!hasMarker) return <SelectableText key={node.key} style={[inheritedStyles, styles.text]}>{node.content}</SelectableText>
      const insideLink = parents.some(parent => parent.type === 'link')
      return <SelectableText key={node.key} style={[inheritedStyles, styles.text]}>{splitInlineRouteMarkerText(node.content, prepared.markers).map((segment, index) => {
        if (!segment.reference) return <SelectableText key={`${node.key}:text:${index}`}>{segment.text}</SelectableText>
        const remote = timelineChatReferenceIsRemote(segment.reference)
        const interactive = !insideLink
          && Boolean(onChatReferencePress)
          && inlineRouteReferenceIsInteractive(segment.reference)
        return <SelectableText
          key={`${node.key}:route:${segment.reference.session_id}:${index}`}
          accessibilityRole={interactive ? 'link' : undefined}
          accessibilityLabel={insideLink
            ? undefined
            : remote
              ? `${segment.text}, secure route on paired server`
              : interactive
                ? `Open ${segment.reference.display_title_snapshot}`
                : `${segment.text}, route unavailable`}
          onPress={interactive ? () => onChatReferencePress?.(segment.reference!) : undefined}
          style={!insideLink ? [inlineReferenceStyles.marker, { color: remote ? colors.muted : colors.blue, backgroundColor: `${remote ? colors.muted : colors.blue}1A` }] : undefined}
        >{segment.text}</SelectableText>
      })}</SelectableText>
    },
    hardbreak: (node, _children, _parents, styles) => (
      <SelectableText key={node.key} style={styles.hardbreak}>{'\n'}</SelectableText>
    ),
    softbreak: (node, _children, _parents, styles) => (
      <SelectableText key={node.key} style={styles.softbreak}>{'\n'}</SelectableText>
    ),
    inline: (node, children, _parents, styles) => (
      <SelectableText key={node.key} style={styles.inline}>{children}</SelectableText>
    ),
    span: (node, children, _parents, styles) => (
      <SelectableText key={node.key} style={styles.span}>{children}</SelectableText>
    ),
    code_block: (node, _children, _parents, styles, inheritedStyles) => (
      <SelectableText key={node.key} selectable uiTextView style={[inheritedStyles, styles.code_block]}>
        {restoreInlineRouteMarkerText(trimTrailingCodeNewline(node.content), prepared.markers)}
      </SelectableText>
    ),
    fence: (node, _children, _parents, styles, inheritedStyles) => {
      const code = restoreInlineRouteMarkerText(trimTrailingCodeNewline(node.content), prepared.markers)
      const block = (
        <SelectableText key={node.key} selectable uiTextView style={[inheritedStyles, styles.fence]}>
          {code}
        </SelectableText>
      )
      // The info string is on the raw token but missing from the typed AST node.
      const language = (node as ASTNode & { sourceInfo?: string }).sourceInfo?.trim().split(/\s+/)[0]
      return language === 'mermaid' ? <MermaidDiagram key={node.key} source={code}>{block}</MermaidDiagram> : block
    },
    table: (node, children, _parents, markdownStyles) => {
      const widths = tableColumnWidths(node)
      return (
        <View key={node.key} style={styles.tableFrame}>
          <ScrollView
            horizontal
            nestedScrollEnabled
            directionalLockEnabled
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={widths.length > 1}
            style={styles.tableScroll}
            contentContainerStyle={styles.tableScrollContent}
          >
            <View
              style={[
                markdownStyles._VIEW_SAFE_table,
                styles.tableContent,
                { minWidth: widths.reduce((sum, width) => sum + width, 0) },
              ]}
            >
              {children}
            </View>
          </ScrollView>
          {/* An overlay, not a row: the collapsed table's layout does not change. The
              sheet renders without chat references, so marker glyphs go back to their
              @mention text before the source is re-parsed. */}
          {expandableTables ? (
            <View style={styles.tableExpand}>
              <IconButton
                icon={Maximize2}
                size={14}
                touchSize={30}
                label="Expand table"
                testID="markdown-table-expand"
                onPress={() => setExpandedTable(restoreInlineRouteMarkerText(markdownTableSource(node), prepared.markers))}
              />
            </View>
          ) : null}
        </View>
      )
    },
    // Content-sized columns. `flex: 0` clears the library's `flex: 1` (zero
    // basis, shrinkable) so `width` sizes the cell even in Yoga's unconstrained
    // measure pass, where flexBasis is ignored; cells still grow to fill a
    // table narrower than the phone but never shrink, so words never split.
    th: (node, children, parents, markdownStyles) => (
      <View key={node.key} style={[markdownStyles._VIEW_SAFE_th, { flex: 0, flexGrow: 1, width: tableColumnWidths(parents.find(parent => parent.type === 'table')!)[node.index] }]}>
        {children}
      </View>
    ),
    td: (node, children, parents, markdownStyles) => (
      <View key={node.key} style={[markdownStyles._VIEW_SAFE_td, { flex: 0, flexGrow: 1, width: tableColumnWidths(parents.find(parent => parent.type === 'table')!)[node.index] }]}>
        {children}
      </View>
    ),
    math_inline: (node, _children, _parents, _styles, inheritedStyles) => (
      <MathFormula
        key={node.key}
        source={restoreInlineRouteMarkerText(node.content, prepared.markers)}
        raw={restoreInlineRouteMarkerText(mathNodeRaw(node), prepared.markers)}
        color={textColor}
        fontSize={inheritedFontSize(inheritedStyles, defaultMathFontSize)}
        mathDisplay={mathNodeUsesDisplayStyle(node)}
        block={false}
      />
    ),
    math_display: (node, _children, _parents, _styles, inheritedStyles) => (
      <MathFormula
        key={node.key}
        source={restoreInlineRouteMarkerText(node.content, prepared.markers)}
        raw={restoreInlineRouteMarkerText(mathNodeRaw(node), prepared.markers)}
        color={textColor}
        fontSize={inheritedFontSize(inheritedStyles, defaultMathFontSize)}
        mathDisplay
        block
      />
    ),
  }), [colors.blue, colors.muted, textColor, defaultMathFontSize, expandableTables, onChatReferencePress, openLink, prepared.markers, tableColumnWidths])

  return (
    <>
      <Markdown markdownit={chatMarkdown} rules={markdownRules} style={markdownStyle} onLinkPress={openLink}>{prepared.text}</Markdown>
      {/* Mounted only while open, so a collapsed table is laid out once, in the timeline. */}
      {expandedTable !== null ? (
        <MarkdownTableSheet onClose={() => setExpandedTable(null)}>
          {/* Same renderer, one table: at least the 15.5 pt body, never smaller than the timeline for large-font users. */}
          <MarkdownContent value={expandedTable} fontScale={Math.max(1, fontScale)} color={color} expandableTables={false} />
        </MarkdownTableSheet>
      ) : null}
    </>
  )
}

function trimTrailingCodeNewline(content: string): string {
  return content.endsWith('\n') ? content.slice(0, -1) : content
}

function containsInlineAttachment(node: ASTNode): boolean {
  if (node.type === 'math_inline' || node.type === 'image') return true
  return node.children?.some(containsInlineAttachment) ?? false
}

function MathFormula({ source, raw, color, fontSize, mathDisplay, block }: { source: string; raw: string; color: string; fontSize: number; mathDisplay: boolean; block: boolean }) {
  const rendered = useMemo(() => texToSvg(source, mathDisplay), [mathDisplay, source])
  if (!rendered) return <NativeText selectable style={{ color, fontSize }}>{raw}</NativeText>

  const width = Math.max(1, Math.ceil(rendered.widthEm * fontSize))
  const height = Math.max(1, Math.ceil(rendered.heightEm * fontSize))
  const fallback = <NativeText selectable style={{ color, fontSize }}>{raw}</NativeText>
  const svg = (
    <SvgXml
      xml={rendered.xml}
      width={width}
      height={height}
      color={color}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Math formula: ${source}`}
      fallback={fallback}
      onError={() => undefined}
      pointerEvents="none"
    />
  )
  if (!block) return svg
  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      directionalLockEnabled
      showsHorizontalScrollIndicator={width > 320}
      style={styles.mathDisplay}
      contentContainerStyle={styles.mathDisplayContent}
    >
      {svg}
    </ScrollView>
  )
}

function inheritedFontSize(style: unknown, fallback: number): number {
  const fontSize = (StyleSheet.flatten(style as TextStyle) as TextStyle | undefined)?.fontSize
  return typeof fontSize === 'number' && Number.isFinite(fontSize) && fontSize > 0 ? fontSize : fallback
}

function mathNodeRaw(node: ASTNode): string {
  const metadata = (node as ASTNode & { sourceMeta?: { raw?: unknown } }).sourceMeta
  if (typeof metadata?.raw === 'string') return metadata.raw
  if (node.markup === '$$') return `$$${node.content}$$`
  if (node.markup === '\\[') return `\\[${node.content}\\]`
  if (node.markup === '\\(') return `\\(${node.content}\\)`
  return `$${node.content}$`
}

function mathNodeUsesDisplayStyle(node: ASTNode): boolean {
  const metadata = (node as ASTNode & { sourceMeta?: { display?: unknown } }).sourceMeta
  return metadata?.display === true
}

const styles = StyleSheet.create({
  mathDisplay: { width: '100%', marginVertical: 4 },
  mathDisplayContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: 2 },
  tableFrame: { width: '100%', marginBottom: 10 },
  tableScroll: { width: '100%', maxWidth: '100%' },
  tableScrollContent: { flexGrow: 1 },
  tableContent: { flexGrow: 1 },
  tableExpand: { position: 'absolute', top: 0, right: 0 },
})
