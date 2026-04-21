import {DEFAULT_MEASURE_COLOR, packColor} from '../render/packColor'
import type {Measure, System, Track} from '../types'

/**
 * In-place repaint of a track's color-bearing buffers using `resolve`, a
 * function that returns a packed `0xRRGGBBAA` color for each measure.
 *
 * We deliberately only touch the `colors` arrays:
 *
 *   - `SliceBuffers.colors`: one entry per slice, aligned with
 *     `measures`. Rebuilt by iterating `measures` in order.
 *   - `SliceMipmap.levels[i].colors`: the mipmap's "dominant contributor"
 *     color per bucket. At parse time this is the color of the widest
 *     source slice in the bucket; we preserve that heuristic by walking
 *     the base buffers per-depth, computing the new dominant color, and
 *     writing it back bucket-by-bucket.
 *
 * Structural fields (`starts`, `ends`, `depths`, `counts`, `sourceStart`,
 * `maxEndsPrefix`) are untouched — this function is O(n slices) and
 * never allocates new typed arrays. Safe to call on every persona switch.
 */
export function rebuildTrackColors(
  track: Track,
  system: System,
  resolve: (m: Measure, track: Track, system: System) => number,
): void {
  const buffers = track.buffers
  if (!buffers || buffers.count === 0) return

  for (let i = 0; i < buffers.count; i++) {
    buffers.colors[i] = resolve(buffers.measures[i], track, system)
  }

  const mipmap = track.mipmap
  if (!mipmap || mipmap.levels.length === 0) return

  // Rebuild each level's dominant-color array using the same rule the
  // parser used: for each bucket at (start, end, depth), pick the color
  // of the widest contributing base slice. `sourceStart` points to the
  // first base slice; we scan forward by base index as long as the base
  // slice falls inside [start, end] and has the same depth.
  const base = buffers
  const starts = base.starts
  const ends = base.ends
  const depths = base.depths
  const colors = base.colors

  for (const level of mipmap.levels) {
    const lStarts = level.starts
    const lEnds = level.ends
    const lDepths = level.depths
    const lColors = level.colors
    const lSourceStart = level.sourceStart
    const lCounts = level.counts

    for (let b = 0; b < level.count; b++) {
      // Singletons: bucket covers exactly one source slice; just copy
      // its (possibly newly painted) color.
      if (lCounts[b] === 1) {
        lColors[b] = colors[lSourceStart[b]]
        continue
      }

      const bStart = lStarts[b]
      const bEnd = lEnds[b]
      const bDepth = lDepths[b]
      let dominantDur = -1
      let dominantColor = DEFAULT_MEASURE_COLOR

      // Scan forward from the recorded source start. Base indices are
      // pre-order so children of the current depth interleave at deeper
      // depths — skip those and stop once we leave the bucket range.
      // (`bEnd` on the bucket is the max of contained slice ends, so we
      // iterate while the base slice *starts* before that.)
      for (let i = lSourceStart[b]; i < base.count; i++) {
        const s = starts[i]
        if (s > bEnd) break
        if (s < bStart) continue
        if (depths[i] !== bDepth) continue
        const width = ends[i] - s
        if (width > dominantDur) {
          dominantDur = width
          dominantColor = colors[i]
        }
      }
      lColors[b] = dominantColor
    }
  }
}

/**
 * Utility: pack a CategoryDef color string once, memoized per-call site.
 * Exported for reuse in applyPersona where rules share a small palette.
 */
export function packCategoryPalette(
  categories: Array<{id: string; color: string}>,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of categories) {
    out.set(c.id, packColor(c.color, DEFAULT_MEASURE_COLOR))
  }
  return out
}
