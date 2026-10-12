// An escape sequence at the end of a string: CSI, OSC or DCS/APC/PM/SOS strings, or a two-byte ESC.
const TRAILING_SEQUENCE = /(?:\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_^X][^\x1b]*\x1b\\|\x1b[\x20-\x7e])$/

/**
 * Where the run of escape sequences that ends a replayed scrollback begins. Queries before it were
 * followed by more output, so the program already had its answer; queries in it may still be
 * waiting, like the device-attributes probe a shell sends before its first prompt.
 */
export function trailingSequencesStart(data: string): number {
  let end = data.length
  for (let match = TRAILING_SEQUENCE.exec(data.slice(0, end)); match; match = TRAILING_SEQUENCE.exec(data.slice(0, end))) {
    end = match.index
  }
  return end
}
