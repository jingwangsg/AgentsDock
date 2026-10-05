import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { UITextView as SelectableText } from '@bsky.app/react-native-uitextview'
import * as Clipboard from 'expo-clipboard'
import { Linking, Platform, ScrollView, StyleSheet, Text as NativeText, View, type TextStyle } from 'react-native'
import { Maximize2 } from 'lucide-react-native'
import markdownItCjkFriendly from 'markdown-it-cjk-friendly'
import Markdown, { MarkdownIt, renderRules, type ASTNode, type RenderRules } from 'react-native-markdown-display'
import { SvgXml } from 'react-native-svg'

import type { ChatReference } from '../types'
import { showActionMenu } from '../lib/action-menu'
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
import { codexFollowupPrompt, rewriteCodexDirectives } from '../lib/codex-directives'
import { openWorkspacePathLink } from '../lib/workspace-path-links'
import { highlightCode } from '../lib/code-highlight'
import { texToSvg } from '../lib/tex-svg'
import { scaleChatFont } from '../lib/typography'
import { useAppStore } from '../store/useAppStore'
import { useAppColorScheme, usePalette } from '../theme'
import { CopyTextButton } from './CopyTextButton'
import { MarkdownTableSheet } from './MarkdownTableSheet'
import { MermaidDiagram } from './MermaidDiagram'
import { IconButton } from './ui'

// markdownItCjkFriendly: CommonMark refuses `**…。**他` as bold because the
// closing `**` sits between CJK punctuation and a letter; models write this
// constantly. Same fix as the desktop's remark-cjk-friendly.
// linkify: a bare URL in a reply is tappable like a Markdown link. Only addresses with a scheme,
// like the desktop's autolinks: fuzzy matching would turn `setup.py` in prose into a web link.
const chatMarkdown = installMarkdownTableSource(installMathMarkdown(new MarkdownIt({ typographer: true, linkify: true }).use(markdownItCjkFriendly)))
chatMarkdown.linkify.set({ fuzzyLink: false, fuzzyEmail: false })
const isWebLink = (href: string) => /^https?:\/\//i.test(href)
const EMPTY_CHAT_REFERENCES: readonly ChatReference[] = []
const inlineReferenceStyles = StyleSheet.create({ marker: { borderRadius: 4, fontWeight: '800' } })

export function MarkdownContent({
  value,
  fontScale = 1,
  compact = false,
  color,
  inlineChatReferences = EMPTY_CHAT_REFERENCES,
  sourceSessionId,
  webLinks = 'tab',
  onChatReferencePress,
  expandableTables = true,
}: {
  value: string
  fontScale?: number
  compact?: boolean
  color?: string
  inlineChatReferences?: readonly ChatReference[]
  /** Where a web link opens: the app's browser tab, or the system browser when this text sits in a sheet that would hide the tab. */
  webLinks?: 'tab' | 'system'
  sourceSessionId?: string
  onChatReferencePress?: (reference: ChatReference) => void
  expandableTables?: boolean
}) {
  const colors = usePalette()
  const colorScheme = useAppColorScheme()
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
  // After route preparation, whose markers are matched against the original text.
  const markdownText = useMemo(() => rewriteCodexDirectives(prepared.text), [prepared.text])
  const openLink = useCallback((url: string) => {
    const followup = codexFollowupPrompt(url)
    if (followup !== null) {
      // A suggestion goes into the composer for review; it is never sent from here.
      if (sourceSessionId) {
        const store = useAppStore.getState()
        const current = store.drafts[sourceSessionId] ?? ''
        store.setSessionDraft(sourceSessionId, current.trim() ? `${current.replace(/\s+$/, '')}\n\n${followup}` : followup)
      }
      return false
    }
    if (openCanvasLink(url, sourceSessionId ?? null)) return false
    if (openWorkspacePathLink(url, sourceSessionId ?? null)) return false
    if (isWebLink(url) && webLinks === 'tab') {
      // Web links open in the app's browser tab; the long-press menu offers the system browser.
      void useAppStore.getState().openLinkInBrowser(url, sourceSessionId ?? null)
      return false
    }
    void Linking.openURL(url).catch(() => undefined)
    return false
  }, [sourceSessionId, webLinks])
  const linkMenu = useCallback((url: string) => showActionMenu(url, [
    { text: 'Copy link', onPress: () => { void Clipboard.setStringAsync(url).catch(() => undefined) } },
    { text: 'Open in browser', onPress: () => { void Linking.openURL(url).catch(() => undefined) } },
  ]), [])
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
    // On Android they are not selectable: only non-selectable Text draws the
    // layout its attachments were placed on (withAndroidPreparedTextLayout);
    // selectable Text is drawn by the platform TextView, which OEM text
    // engines can lay out differently, moving formulas off their slot.
    textgroup: (node, children, _parents, styles) => {
      if (containsInlineAttachment(node)) {
        return <NativeText key={node.key} selectable={Platform.OS !== 'android'} style={styles.textgroup}>{children}</NativeText>
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
    link: (node, children, _parents, styles) => {
      const href = String(node.attributes.href ?? '')
      return <SelectableText
        key={node.key}
        style={styles.link}
        onPress={() => openLink(href)}
        onLongPress={isWebLink(href) ? () => linkMenu(href) : undefined}
      >
        {children}
      </SelectableText>
    },
    // A server-local image cannot load (the library would fetch `https://<path>`). Inside a link
    // (a blocklink, since images are block tokens) the tap follows that link.
    image: (node, children, parents, styles, allowedImageHandlers, defaultImageHandler) => {
      const { src, alt } = node.attributes
      if (allowedImageHandlers.some(prefix => src.toLowerCase().startsWith(prefix.toLowerCase()))) {
        return renderRules.image!(node, children, parents, styles, allowedImageHandlers, defaultImageHandler)
      }
      const insideLink = parents.some(parent => parent.type === 'blocklink')
      return (
        <SelectableText key={node.key} style={styles.link} onPress={insideLink ? undefined : () => openLink(src)}>
          {alt || src}
        </SelectableText>
      )
    },
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
    code_block: (node, _children, _parents, styles, inheritedStyles) => {
      const code = restoreInlineRouteMarkerText(trimTrailingCodeNewline(node.content), prepared.markers)
      return <CodeFrame key={node.key} code={code}>
        <SelectableText selectable uiTextView style={[inheritedStyles, styles.code_block, codeFrameStyles.text]}>{code}</SelectableText>
      </CodeFrame>
    },
    fence: (node, _children, _parents, styles, inheritedStyles) => {
      const code = restoreInlineRouteMarkerText(trimTrailingCodeNewline(node.content), prepared.markers)
      // The info string is on the raw token but missing from the typed AST node.
      const language = (node as ASTNode & { sourceInfo?: string }).sourceInfo?.trim().split(/\s+/)[0]
      const runs = language === 'mermaid' ? null : highlightCode(code, language, colorScheme)
      const block = (
        <CodeFrame key={node.key} code={code}><SelectableText selectable uiTextView style={[inheritedStyles, styles.fence, codeFrameStyles.text]}>
          {runs ? runs.map((run, index) => run.color || run.bold || run.italic
            ? <SelectableText key={index} style={{ color: run.color, fontWeight: run.bold ? '700' : undefined, fontStyle: run.italic ? 'italic' : undefined }}>{run.text}</SelectableText>
            : run.text) : code}
        </SelectableText></CodeFrame>
      )
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
  }), [colors.blue, colors.muted, colorScheme, textColor, defaultMathFontSize, expandableTables, onChatReferencePress, openLink, prepared.markers, tableColumnWidths])

  return (
    <>
      <Markdown markdownit={chatMarkdown} rules={markdownRules} style={markdownStyle} onLinkPress={openLink}>{markdownText}</Markdown>
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

/** A code block with a copy button over its top-right corner, like the desktop's code toolbar. */
function CodeFrame({ code, children }: { code: string; children: ReactNode }) {
  return <View style={codeFrameStyles.frame}>
    {children}
    <View style={codeFrameStyles.copy}><CopyTextButton text={code} label="Copy code" testID="markdown-code-copy" /></View>
  </View>
}

// The text keeps clear of the button so a long first line is not hidden under it.
const codeFrameStyles = StyleSheet.create({
  frame: { position: 'relative' },
  text: { paddingRight: 40 },
  copy: { position: 'absolute', top: 2, right: 2 },
})

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
      // A text attachment's bottom edge sits on the baseline, which lifts
      // subscripts and descenders above it. Draw the formula's depth below
      // the baseline instead; the transform leaves the reserved box unchanged.
      style={block ? undefined : { transform: [{ translateY: rendered.depthEm * fontSize }] }}
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
