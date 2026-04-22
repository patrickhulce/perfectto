import type {SliceBuffers} from '../../core/render/sliceBuffers'
import {lowerBoundF32} from '../../core/render/sliceBuffers'

/**
 * Vertical padding factored into the {@link drawFrame} row layout. Hit-test
 * needs the same value so the band a slice occupies matches what the user
 * actually sees on screen.
 *
 * Kept in sync with `ROW_VPAD_PX` in `canvas2d.ts`. Imported here as a
 * literal because re-exporting from `canvas2d.ts` would drag the canvas
 * draw module into hit-test consumers (workers, tests) for no benefit.
 *
 * Exported so the hover overlay can position itself on the exact same
 * [y, y+h] band the renderer paints into.
 */
export const ROW_VPAD_PX = 4

/**
 * Result of a single track-local hit test. `index` is `-1` on a miss; on a
 * hit it points into `buffers.measures` (and the parallel typed arrays).
 */
export interface HitTestResult {
  index: number
  depth: number
}

const MISS: HitTestResult = {index: -1, depth: -1}

/**
 * Find the deepest slice in `buffers` that contains `(timelineMs,
 * trackLocalY)`. Always reads the raw {@link SliceBuffers} (never a mipmap
 * level) so sub-pixel slices stay reachable on hover even when the renderer
 * has merged them into a density bucket.
 *
 * Strategy:
 *  1. Translate cursor y into a target depth band; if `targetDepth >=
 *     maxDepthExclusive` (collapsed track), bail.
 *  2. Binary-search `maxEndsPrefix` for the earliest index whose slice could
 *     still reach `timelineMs`. Everything before that is guaranteed to end
 *     earlier and can be skipped.
 *  3. Linear-scan forward while `starts[i] <= timelineMs`. The first match at
 *     `depths[i] === targetDepth && ends[i] >= timelineMs` wins — there is at
 *     most one slice per (depth, time) pair by construction (a parent and a
 *     child can't share a depth, and siblings at the same depth don't
 *     overlap in time within a sorted container).
 *
 * Complexity: O(log n) for the lower-bound + O(k) for the scan, where `k` is
 * the number of slices spanning `timelineMs`. In practice `k` is bounded by
 * the depth of the track at that time, so each hover call is essentially
 * constant-time relative to the trace size.
 */
export function hitTestTrack(
  buffers: SliceBuffers,
  timelineMs: number,
  trackLocalY: number,
  rowHeight: number,
  maxDepthExclusive: number,
  minHitboxMs: number = 0,
): HitTestResult {
  if (buffers.count === 0 || rowHeight <= 0) return MISS
  if (trackLocalY < 0) return MISS

  // The drawn rect for depth `d` lives in
  //   y ∈ [d*rowHeight + ROW_VPAD_PX/2, (d+1)*rowHeight - ROW_VPAD_PX/2]
  // so the simplest bijection from y to depth is `floor(y / rowHeight)`.
  // We don't try to "miss" inside the vertical gap between rows because
  // hover already feels jittery if a 1-2px gap silently dismisses the
  // tooltip; matching the row band end-to-end is the kinder behavior.
  const targetDepth = Math.floor(trackLocalY / rowHeight)
  if (targetDepth >= maxDepthExclusive) return MISS

  // Hitbox widening: treat any slice narrower than `minHitboxMs` as if
  // it were `minHitboxMs` wide, centered on the original slice. This
  // only affects slices already narrower than the threshold — wide
  // slices keep their exact `[start, end]` bounds — so normal-sized
  // rects feel pixel-accurate while 0.01ms compositor events become
  // hoverable without aim.
  const halfHit = Math.max(0, minHitboxMs) * 0.5

  // With widening, a slice at index `i` "reaches" `timelineMs` if
  // `e + halfHit >= timelineMs`, so we shift the lower-bound probe by
  // the same amount to keep the binary search correct.
  const first = lowerBoundF32(
    buffers.maxEndsPrefix,
    buffers.count,
    timelineMs - halfHit,
  )

  const starts = buffers.starts
  const ends = buffers.ends
  const depths = buffers.depths
  const count = buffers.count

  // Prefer a slice whose true `[start, end]` contains the cursor (the
  // "exact" hit). If no slice truly contains it, fall back to the
  // nearest widened candidate at the target depth. Within a single
  // depth the renderer never stacks rects at the same time, so there
  // is at most one exact hit; widened candidates can overlap at the
  // boundaries, hence the nearest-center tiebreak.
  let exactIndex = -1
  let nearestIndex = -1
  let nearestDist = Number.POSITIVE_INFINITY
  for (let i = first; i < count; i++) {
    const s = starts[i]
    if (s - halfHit > timelineMs) break
    const e = ends[i]
    if (e + halfHit < timelineMs) continue
    const d = depths[i]
    if (d !== targetDepth) continue

    if (s <= timelineMs && e >= timelineMs) {
      exactIndex = i
      // Exact hits are unique per depth at a timestamp — stop scanning.
      break
    }

    // Widened-only match: track the slice whose center is closest to
    // the cursor, so two adjacent tiny slices break ties intuitively.
    const center = (s + e) * 0.5
    const dist = Math.abs(center - timelineMs)
    if (dist < nearestDist) {
      nearestDist = dist
      nearestIndex = i
    }
  }

  const bestIndex = exactIndex !== -1 ? exactIndex : nearestIndex
  if (bestIndex === -1) return MISS
  return {index: bestIndex, depth: targetDepth}
}

// Visible for tests.
export const __test__ = {ROW_VPAD_PX}

