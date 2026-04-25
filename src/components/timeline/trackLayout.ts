import type {Track} from '../../core'

export const ROW_HEIGHT = 22

/**
 * Returns the total number of flame-chart rows the track needs when
 * fully expanded:
 *
 *   - 0 if the track has no slices and no marks.
 *   - 1 if there are only marks (no slices) — marks render at depth 0.
 *   - `max(buffers.depths) + 1` otherwise — the deepest slice's depth
 *     plus one row to fit it.
 *
 * Reads exclusively from the flat `buffers` / `markBuffers` SoA so it
 * stays O(slices) and, more importantly, doesn't require the recursive
 * `Track.measures` tree to exist in memory. The worker strips that
 * tree before `postMessage` to avoid structured-clone stack overflows
 * on deep traces, so this is the only depth path on the main thread.
 */
export function containerDepth(track: Track): number {
  const buffers = track.buffers
  if (buffers && buffers.count > 0) {
    let maxD = 0
    const depths = buffers.depths
    for (let i = 0; i < buffers.count; i++) {
      if (depths[i] > maxD) maxD = depths[i]
    }
    return maxD + 1
  }
  if (track.markBuffers && track.markBuffers.count > 0) return 1
  return 0
}
