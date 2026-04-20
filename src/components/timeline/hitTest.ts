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
 */
const ROW_VPAD_PX = 4

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

  const first = lowerBoundF32(
    buffers.maxEndsPrefix,
    buffers.count,
    timelineMs,
  )

  const starts = buffers.starts
  const ends = buffers.ends
  const depths = buffers.depths
  const count = buffers.count

  let bestIndex = -1
  let bestDepth = -1
  for (let i = first; i < count; i++) {
    const s = starts[i]
    if (s > timelineMs) break
    const e = ends[i]
    if (e < timelineMs) continue
    const d = depths[i]
    if (d !== targetDepth) continue
    // Iteration order isn't strictly depth-monotonic across all parent /
    // child orderings, but per-depth uniqueness at a single timestamp means
    // the first qualifying hit IS the deepest one whose row contains the
    // cursor. We still keep the "deepest wins" guard so future renderer
    // changes (e.g. multi-row depth packing) stay safe.
    if (d > bestDepth) {
      bestIndex = i
      bestDepth = d
      // The renderer never stacks two rects at the same depth at the same
      // time, so once we've matched `targetDepth` we can stop.
      break
    }
  }

  if (bestIndex === -1) return MISS
  return {index: bestIndex, depth: bestDepth}
}

// Visible for tests.
export const __test__ = {ROW_VPAD_PX}
