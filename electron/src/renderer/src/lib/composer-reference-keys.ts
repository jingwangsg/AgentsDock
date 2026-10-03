import {
  atomicComposerReferenceDeletion,
  atomicComposerReferenceNavigation,
  type ComposerReferenceSpan
} from './team-references'

/**
 * Unmodified Backspace/Delete removes a whole reference span; unmodified
 * ArrowLeft/ArrowRight on a collapsed selection steps over one. Offsets and
 * the returned caret are in source-text coordinates.
 */
export function atomicReferenceKeyAction(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  text: string,
  spans: readonly ComposerReferenceSpan[],
  selectionStart: number,
  selectionEnd: number
): { text: string; caret: number } | { caret: number } | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  if (event.key === 'Backspace' || event.key === 'Delete') {
    return atomicComposerReferenceDeletion(text, spans, selectionStart, selectionEnd, event.key)
  }
  if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && selectionStart === selectionEnd) {
    const caret = atomicComposerReferenceNavigation(selectionStart, spans, event.key)
    return caret === null ? null : { caret }
  }
  return null
}
