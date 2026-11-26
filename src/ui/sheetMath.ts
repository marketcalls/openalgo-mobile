// Where a bottom sheet settles. A snap point is the share of the height the sheet shows (1 is full
// height); the panel is full height and translated down, so its offset is the hidden part.

/** How far below the lowest snap point a release must be carried before the sheet closes. */
export const SHEET_CLOSE_PX = 120
/** Seconds of the release velocity added to where the finger lets go. */
export const SHEET_FLING = 0.15
/** The slide down before the sheet's owner is told it closed. */
export const SHEET_CLOSE_MS = 200

/** The translateY of each snap point: 0 is full height. */
export function sheetOffsets(points: readonly number[], height: number): number[] {
  return points.map((p) => height * (1 - p))
}

/** The snap point a release at `y` with velocity `vy` settles on, or 'close'. */
export function snapIndexFor(y: number, vy: number, offsets: readonly number[]): number | 'close' {
  const projected = y + SHEET_FLING * vy
  if (projected > Math.max(...offsets) + SHEET_CLOSE_PX) return 'close'
  let best = 0
  let nearest = Number.POSITIVE_INFINITY
  for (const [i, offset] of offsets.entries()) {
    const distance = Math.abs(offset - projected)
    if (distance < nearest) {
      best = i
      nearest = distance
    }
  }
  return best
}
