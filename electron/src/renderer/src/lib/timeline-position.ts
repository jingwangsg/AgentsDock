import type { ViewState } from '@shared/types'

export type TimelineInitialLocation = number | { index: number | 'LAST'; align: 'start' | 'center' | 'end'; offset?: number } | undefined

export interface TimelineRemountAnchor {
  atBottom: boolean
  topItemId: string | null
  topOffset?: number
}

export function initialTimelineLocation(
  saved: ViewState | null | undefined,
  itemKeys: string[],
  _unread: boolean,
  _now = Date.now()
): TimelineInitialLocation {
  // Returning to a chat preserves where the reader left off. A first open,
  // a reader already at the bottom, or a missing cached anchor opens latest.
  return remountTimelineLocation({
    atBottom: saved?.atBottom !== false,
    topItemId: saved?.topItemId ?? null,
    topOffset: saved?.topOffset
  }, itemKeys)
}

export function isLatestTimelineLocation(location: TimelineInitialLocation): boolean {
  return typeof location === 'object' && location !== null && location.index === 'LAST'
}

/**
 * Resolve the location for a new Virtuoso source. A replacement generation
 * may reuse a semantic row key, but its old numeric index has no authority in
 * the new array. Preserve the semantic anchor only while it still exists;
 * otherwise land at the verified tail. Explicit history navigation supplies
 * its own sequence-derived location and always wins.
 */
export function remountTimelineLocation(
  anchor: TimelineRemountAnchor,
  itemKeys: string[],
  explicitLocation?: TimelineInitialLocation
): TimelineInitialLocation {
  if (explicitLocation !== undefined) return explicitLocation
  if (!anchor.atBottom && anchor.topItemId) {
    const index = itemKeys.indexOf(anchor.topItemId)
    if (index >= 0) return { index, align: 'start', offset: -(anchor.topOffset ?? 0) }
  }
  return { index: 'LAST', align: 'end' }
}

/**
 * Keep Virtuoso's absolute first index aligned when a stable source prepends
 * rows or slides a bounded window forward. The first row shared by both
 * projections proves how many rows moved across the leading edge.
 */
export function shiftedTimelineFirstItemIndex(
  current: number,
  previousKeys: readonly string[],
  nextKeys: readonly string[]
): number {
  if (!previousKeys.length || !nextKeys.length) return current
  const previousIndexes = new Map(previousKeys.map((key, index) => [key, index]))
  for (let nextIndex = 0; nextIndex < nextKeys.length; nextIndex += 1) {
    const previousIndex = previousIndexes.get(nextKeys[nextIndex])
    if (previousIndex !== undefined) return current + previousIndex - nextIndex
  }
  return current
}

export interface VirtualListCoverage {
  /** paddingTop / paddingBottom: space the list reserves for rows not mounted above / below the rendered ones. */
  paddingTop: number
  paddingBottom: number
  clientHeight: number
  /** Rendered row edges relative to the viewport top. */
  rows: ReadonlyArray<{ top: number; bottom: number }>
}

// Mid-scroll the mounted rows can trail the viewport edge by a few pixels for
// a frame; a gap this large that survives a re-check means the list stopped
// tracking the viewport. (Header, footer and short chats are excluded by the
// padding checks below, not by this.)
const VIRTUAL_LIST_GAP_PX = 64

/**
 * Report reserved-but-unmounted space showing in the viewport: the rendered
 * rows end a gap above the viewport bottom while the list still pads for rows
 * below them, or start a gap below the viewport top while it pads for rows
 * above. Without padding the space is the footer or header, or the chat is
 * shorter than the viewport.
 */
export function virtualListGap(coverage: VirtualListCoverage): 'above' | 'below' | null {
  if (!coverage.rows.length) return null
  const top = Math.min(...coverage.rows.map(row => row.top))
  const bottom = Math.max(...coverage.rows.map(row => row.bottom))
  if (coverage.paddingBottom > 0 && coverage.clientHeight - bottom >= VIRTUAL_LIST_GAP_PX) return 'below'
  if (coverage.paddingTop > 0 && top >= VIRTUAL_LIST_GAP_PX) return 'above'
  return null
}
