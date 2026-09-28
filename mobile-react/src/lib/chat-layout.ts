// 600 is the Material medium-width class: an unfolded book-style foldable
// (Pixel Fold inner 701x841dp, Galaxy Fold ~775dp wide) gets the two-pane
// layout in both orientations instead of a stretched phone list.
export const CHAT_COMPACT_WIDTH = 600
export const CHAT_COMPACT_MIN_DIMENSION = 600
export const INLINE_INSPECTOR_MIN_WIDTH = 1080

export type ChatWorkspaceLayout = {
  compact: boolean
  inlineInspectorAvailable: boolean
}

export function chatWorkspaceLayout(width: number, height: number): ChatWorkspaceLayout {
  const compact = width < CHAT_COMPACT_WIDTH || Math.min(width, height) < CHAT_COMPACT_MIN_DIMENSION
  return {
    compact,
    inlineInspectorAvailable: !compact && width >= INLINE_INSPECTOR_MIN_WIDTH,
  }
}
