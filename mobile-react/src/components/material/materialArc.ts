/** Android's indeterminate progress: the arc's trim cycle and the group's 720° turn. */
export const PROGRESS_TRIM_MS = 1333
export const PROGRESS_ROTATION_MS = 4444

/** cubic-bezier(0.4, 0, 0.2, 1), the curve Android's progress trim interpolators are built from. */
function fastOutSlowIn(x: number): number {
  'worklet'
  if (x <= 0) return 0
  if (x >= 1) return 1
  let t = x
  for (let i = 0; i < 8; i += 1) {
    const u = 1 - t
    const bx = 3 * u * u * t * 0.4 + 3 * u * t * t * 0.2 + t * t * t
    const dx = 3 * u * u * 0.4 + 6 * u * t * (0.2 - 0.4) + 3 * t * t * (1 - 0.2)
    if (Math.abs(bx - x) < 1e-5 || dx === 0) break
    t = Math.min(1, Math.max(0, t - (bx - x) / dx))
  }
  const u = 1 - t
  return 3 * u * t * t + t * t * t
}

/** SVG path of a clockwise arc from `start` to `end` turns, measured from 12 o'clock. */
export function arcPath(cx: number, cy: number, radius: number, start: number, end: number): string {
  'worklet'
  // Android draws nothing for an empty trim; a square-capped empty arc would leave a dot.
  if (end - start < 0.001) return `M ${cx} ${cy}`
  const angle = (turns: number) => (turns * 360 - 90) * Math.PI / 180
  const x0 = cx + radius * Math.cos(angle(start))
  const y0 = cy + radius * Math.sin(angle(start))
  const x1 = cx + radius * Math.cos(angle(end))
  const y1 = cy + radius * Math.sin(angle(end))
  return `M ${x0} ${y0} A ${radius} ${radius} 0 ${end - start > 0.5 ? 1 : 0} 1 ${x1} ${y1}`
}

/**
 * Android's indeterminate progress arc (AOSP progress_indeterminate_material): at trim progress
 * `p` (0–1 over one 1333 ms cycle) the arc's start and end follow fast-out-slow-in curves up to
 * 0.75 of the circle, offset by a quarter turn per cycle, all turned by `rotation` degrees.
 */
export function indeterminateArc(p: number, rotation: number, cx: number, cy: number, radius: number): string {
  'worklet'
  const offset = 0.25 * p + rotation / 360
  const start = (p < 0.5 ? 0 : fastOutSlowIn((p - 0.5) * 2)) * 0.75 + offset
  const end = (p < 0.5 ? fastOutSlowIn(p * 2) : 1) * 0.75 + offset
  return arcPath(cx, cy, radius, start, end)
}
