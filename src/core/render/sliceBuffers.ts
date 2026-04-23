import type {Mark, Measure, TimelineContainer} from '../types'
import {
  DEFAULT_MARK_COLOR,
  DEFAULT_MEASURE_COLOR,
  packColor,
} from './packColor'

/**
 * Flat, struct-of-arrays view of every measure in a track's subtree. Built
 * once at parse finalize; the canvas renderer reads it directly each frame.
 *
 * All arrays are parallel: index `i` refers to the same slice across them.
 * `starts` is sorted ascending (pre-order walk emits ancestors before their
 * children, which preserves start order as long as children are themselves
 * sorted — which `finalizeContainer` guarantees). The canvas culler binary
 * searches on `starts` and iterates forward until the first `starts[i] >
 * visibleEndMs`.
 */
export interface SliceBuffers {
  count: number
  /** Absolute start time in ms (same units as `Timeline.start`). */
  starts: Float32Array
  /** Absolute end time in ms. */
  ends: Float32Array
  /** Nesting depth measured from the track root (0 = direct child of track). */
  depths: Uint16Array
  /** Packed `0xRRGGBBAA` color per slice. */
  colors: Uint32Array
  /** Back-pointer into `measures` for future hit-test / tooltip work. */
  measures: Measure[]
  /**
   * Running maximum of `ends[0..i]`. Non-decreasing (since it's a running
   * max), so the canvas culler can binary-search it for `visibleStartMs`
   * and safely skip every index before the answer — they're all guaranteed
   * to end before the viewport. Without this, a parent slice at index 0
   * with `end = trackDuration` would be culled the moment the viewport
   * scrolls past any of its children's start times.
   */
  maxEndsPrefix: Float32Array
  /**
   * Direct parent's end time in ms, per slice. Depth-0 slices use their
   * own `ends[i]` as a sentinel (they have no flame-chart parent). The
   * mipmap uses this as a parent-identity key so it won't merge two
   * same-depth siblings that live under different parents into a single
   * wide bucket — which would otherwise render a rect that visually
   * "bridges" two parents.
   */
  parentEnds: Float32Array
}

/** Same shape as {@link SliceBuffers} but keyed on a single `time` per mark. */
export interface MarkBuffers {
  count: number
  times: Float32Array
  depths: Uint16Array
  colors: Uint32Array
  marks: Mark[]
}

const EMPTY_F32 = new Float32Array(0)
const EMPTY_U16 = new Uint16Array(0)
const EMPTY_U32 = new Uint32Array(0)

export const EMPTY_SLICE_BUFFERS: SliceBuffers = {
  count: 0,
  starts: EMPTY_F32,
  ends: EMPTY_F32,
  depths: EMPTY_U16,
  colors: EMPTY_U32,
  measures: [],
  maxEndsPrefix: EMPTY_F32,
  parentEnds: EMPTY_F32,
}

export const EMPTY_MARK_BUFFERS: MarkBuffers = {
  count: 0,
  times: EMPTY_F32,
  depths: EMPTY_U16,
  colors: EMPTY_U32,
  marks: [],
}

/**
 * Walk a container's measure subtree in pre-order and collect it into typed
 * arrays. The resulting `starts` array is sorted because the input is sorted
 * by `finalizeContainer` and pre-order visits a parent before its (sorted)
 * children, whose starts are all ≥ parent.start.
 */
export function buildSliceBuffers(root: TimelineContainer): SliceBuffers {
  const total = countMeasures(root)
  if (total === 0) return EMPTY_SLICE_BUFFERS

  const starts = new Float32Array(total)
  const ends = new Float32Array(total)
  const depths = new Uint16Array(total)
  const colors = new Uint32Array(total)
  const measures = new Array<Measure>(total)
  // Direct parent's end time per slice, used by the mipmap as a
  // parent-identity key. Depth-0 roots all share a single sentinel (0)
  // because they're all peers under the track itself; refusing to merge
  // them would over-split rows that have no flame-chart parent. Depth-1+
  // slices store their direct ancestor's F32-rounded `end`, which is
  // byte-identical across every child of that ancestor.
  const parentEnds = new Float32Array(total)
  const PARENT_END_ROOT = 0

  let i = 0
  const visit = (
    container: TimelineContainer,
    depth: number,
    parentEnd: number,
  ): void => {
    for (const m of container.measures) {
      starts[i] = m.start
      ends[i] = m.end
      depths[i] = depth > 0xffff ? 0xffff : depth
      colors[i] = packColor(m.color, DEFAULT_MEASURE_COLOR)
      measures[i] = m
      parentEnds[i] = parentEnd
      i += 1
      // Pass `ends[i-1]` (F32-rounded, exactly as it will appear in any
      // sibling's parentEnds slot) so every child of this measure stores
      // the identical key.
      if (m.measures.length > 0) visit(m, depth + 1, ends[i - 1])
    }
  }
  visit(root, 0, PARENT_END_ROOT)

  const maxEndsPrefix = new Float32Array(i)
  let running = -Infinity
  for (let k = 0; k < i; k++) {
    const e = ends[k]
    if (e > running) running = e
    maxEndsPrefix[k] = running
  }

  return {
    count: i,
    starts,
    ends,
    depths,
    colors,
    measures,
    maxEndsPrefix,
    parentEnds,
  }
}

/**
 * Flatten every mark in a container subtree. Marks live at the depth of
 * whichever measure contains them, so a mark attached to a nested measure
 * still renders at that measure's row.
 */
export function buildMarkBuffers(root: TimelineContainer): MarkBuffers {
  const total = countMarks(root)
  if (total === 0) return EMPTY_MARK_BUFFERS

  const times = new Float32Array(total)
  const depths = new Uint16Array(total)
  const colors = new Uint32Array(total)
  const marks = new Array<Mark>(total)

  let i = 0
  const visit = (container: TimelineContainer, depth: number): void => {
    for (const mk of container.marks) {
      times[i] = mk.time
      depths[i] = depth > 0xffff ? 0xffff : depth
      colors[i] = packColor(mk.color, DEFAULT_MARK_COLOR)
      marks[i] = mk
      i += 1
    }
    for (const m of container.measures) visit(m, depth + 1)
  }
  visit(root, 0)

  // Marks across nested containers aren't guaranteed to be globally sorted —
  // a late mark on a nested measure can appear after all root-level marks.
  // Sort by time so the canvas can binary-search.
  if (!isSortedAscending(times)) sortInPlaceByTime(times, depths, colors, marks)

  return {count: i, times, depths, colors, marks}
}

function countMeasures(root: TimelineContainer): number {
  let n = 0
  const visit = (c: TimelineContainer): void => {
    n += c.measures.length
    for (const m of c.measures) visit(m)
  }
  visit(root)
  return n
}

function countMarks(root: TimelineContainer): number {
  let n = 0
  const visit = (c: TimelineContainer): void => {
    n += c.marks.length
    for (const m of c.measures) visit(m)
  }
  visit(root)
  return n
}

function isSortedAscending(arr: Float32Array): boolean {
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < arr[i - 1]) return false
  }
  return true
}

function sortInPlaceByTime(
  times: Float32Array,
  depths: Uint16Array,
  colors: Uint32Array,
  marks: Mark[],
): void {
  const n = times.length
  const order = new Uint32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  const orderArr = Array.from(order)
  orderArr.sort((a, b) => times[a] - times[b])

  const t2 = new Float32Array(n)
  const d2 = new Uint16Array(n)
  const c2 = new Uint32Array(n)
  const m2 = new Array<Mark>(n)
  for (let i = 0; i < n; i++) {
    const src = orderArr[i]
    t2[i] = times[src]
    d2[i] = depths[src]
    c2[i] = colors[src]
    m2[i] = marks[src]
  }
  times.set(t2)
  depths.set(d2)
  colors.set(c2)
  for (let i = 0; i < n; i++) marks[i] = m2[i]
}

/**
 * Smallest index `i` such that `starts[i] >= target`, or `count` if none.
 * Binary-search lower bound on a Float32Array view.
 */
export function lowerBoundF32(arr: Float32Array, count: number, target: number): number {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Max depth (exclusive upper bound → number of rows) for a SliceBuffers. */
export function maxDepthPlusOne(buffers: SliceBuffers): number {
  let maxD = 0
  for (let i = 0; i < buffers.count; i++) {
    if (buffers.depths[i] > maxD) maxD = buffers.depths[i]
  }
  return buffers.count === 0 ? 0 : maxD + 1
}

// ---------------------------------------------------------------------------
// Mipmap / LOD (Phase 2)
// ---------------------------------------------------------------------------

/**
 * One level of a {@link SliceMipmap}. Shares the struct-of-arrays shape with
 * {@link SliceBuffers} so the canvas renderer can consume either via the same
 * hot loop. Merged buckets aggregate several source slices into a single rect
 * whose alpha is modulated by density at draw time.
 */
export interface SliceMipmapLevel {
  count: number
  starts: Float32Array
  ends: Float32Array
  depths: Uint16Array
  /** Packed `0xRRGGBBAA` of the dominant (longest) contributor per bucket. */
  colors: Uint32Array
  /** Non-decreasing running max of `ends[0..i]`, same semantics as SliceBuffers. */
  maxEndsPrefix: Float32Array
  /** Number of source slices aggregated into bucket `i` (1 for singletons). */
  counts: Uint32Array
  /**
   * Index of the first source slice in {@link SliceMipmap.base} that
   * contributed to this bucket. Phase 3.5 uses this to drill back to the raw
   * slice under the cursor; Phase 2 itself never reads it at draw time.
   */
  sourceStart: Uint32Array
  /** Minimum slice width preserved at this level, in ms. */
  resolutionMs: number
}

/**
 * LOD pyramid over a track's {@link SliceBuffers}. `levels` is ordered finest
 * → coarsest (ascending `resolutionMs`). Empty when the base is empty.
 */
export interface SliceMipmap {
  base: SliceBuffers
  levels: SliceMipmapLevel[]
}

/** Smallest resolution we build a level for. 2^1 * 0.25ms = 0.5ms. */
const MIPMAP_MIN_LEVEL = 1
/** Coarsest level before we bail out. 2^16 * 0.25ms ≈ 16.4s. */
const MIPMAP_MAX_LEVEL = 16
/** ms-per-level-index; actual resolution is `MIPMAP_BASE_MS * 2^L`. */
const MIPMAP_BASE_MS = 0.25
/**
 * Once a level has shrunk below this bucket count there's nothing meaningful
 * left to aggregate — further levels would just be weaker copies of the same
 * handful of rects.
 */
const MIPMAP_FLOOR_BUCKETS = 128

/**
 * Build a LOD pyramid over a base {@link SliceBuffers}. For each fixed power
 * of two, walk the base per-depth (so nested rows never merge into a shared
 * bucket) and collapse runs of sub-resolution slices into density buckets.
 *
 * Cost: O(n) per level × O(log n) levels before the 128-bucket floor kicks
 * in. Memory: bounded by ~2× the base count in the geometric worst case
 * because each level halves bucket count on dense traces.
 */
export function buildSliceMipmap(base: SliceBuffers): SliceMipmap {
  if (base.count === 0) return {base, levels: []}

  // Partition base indices by depth so per-depth bucketing stays cheap in the
  // inner loop. Each row's indices are already sorted by start (pre-order
  // walk on a sorted tree).
  const perDepth = partitionByDepth(base)

  const levels: SliceMipmapLevel[] = []
  for (let L = MIPMAP_MIN_LEVEL; L <= MIPMAP_MAX_LEVEL; L++) {
    const resolutionMs = MIPMAP_BASE_MS * 2 ** L
    const level = buildMipmapLevel(base, perDepth, resolutionMs)
    if (level.count === 0) break
    levels.push(level)
    if (level.count <= MIPMAP_FLOOR_BUCKETS) break
  }

  return {base, levels}
}

function partitionByDepth(base: SliceBuffers): Uint32Array[] {
  const depths = base.depths
  const count = base.count
  let maxD = 0
  for (let i = 0; i < count; i++) {
    if (depths[i] > maxD) maxD = depths[i]
  }
  const rowCount = count === 0 ? 0 : maxD + 1
  const sizes = new Uint32Array(rowCount)
  for (let i = 0; i < count; i++) sizes[depths[i]] += 1
  const rows: Uint32Array[] = new Array(rowCount)
  for (let d = 0; d < rowCount; d++) rows[d] = new Uint32Array(sizes[d])
  const cursors = new Uint32Array(rowCount)
  for (let i = 0; i < count; i++) {
    const d = depths[i]
    rows[d][cursors[d]++] = i
  }
  return rows
}

/**
 * Bucket one resolution level. A bucket is either a singleton (slice wider
 * than `resolutionMs`, passed through untouched) or a density bucket
 * (contiguous run of sub-resolution slices, possibly with small gaps under
 * `resolutionMs`).
 */
function buildMipmapLevel(
  base: SliceBuffers,
  perDepth: Uint32Array[],
  resolutionMs: number,
): SliceMipmapLevel {
  const starts = base.starts
  const ends = base.ends
  const colors = base.colors
  const parentEnds = base.parentEnds

  // Worst case: no merges happen at this level and we emit base.count buckets.
  // We allocate tight arrays at the end from the final count.
  const tmpStarts: number[] = []
  const tmpEnds: number[] = []
  const tmpDepths: number[] = []
  const tmpColors: number[] = []
  const tmpCounts: number[] = []
  const tmpSourceStart: number[] = []

  for (let d = 0; d < perDepth.length; d++) {
    const row = perDepth[d]
    const rowLen = row.length
    if (rowLen === 0) continue

    let bucketOpen = false
    let bStart = 0
    let bEnd = 0
    let bColor = 0
    let bCount = 0
    let bSourceStart = 0
    let bDominantDur = -1
    // Parent-identity key of the currently open bucket. Only slices that
    // share this key may extend the bucket — otherwise two same-depth
    // siblings under different parents would be collapsed into one wide
    // rect that visually "bridges" two parents.
    let bParentEnd = 0

    const flush = (): void => {
      if (!bucketOpen) return
      tmpStarts.push(bStart)
      tmpEnds.push(bEnd)
      tmpDepths.push(d)
      tmpColors.push(bColor)
      tmpCounts.push(bCount)
      tmpSourceStart.push(bSourceStart)
      bucketOpen = false
      bDominantDur = -1
    }

    for (let k = 0; k < rowLen; k++) {
      const i = row[k]
      const s = starts[i]
      const e = ends[i]
      const width = e - s
      const parentEnd = parentEnds[i]

      if (width >= resolutionMs) {
        // Wide slice: flush any open merged bucket, then emit this slice as a
        // singleton. Not merged forward so wide siblings keep their identity.
        flush()
        tmpStarts.push(s)
        tmpEnds.push(e)
        tmpDepths.push(d)
        tmpColors.push(colors[i])
        tmpCounts.push(1)
        tmpSourceStart.push(i)
        continue
      }

      if (
        bucketOpen &&
        s - bEnd < resolutionMs &&
        parentEnd === bParentEnd
      ) {
        if (e > bEnd) bEnd = e
        bCount += 1
        if (width > bDominantDur) {
          bDominantDur = width
          bColor = colors[i]
        }
      } else {
        flush()
        bucketOpen = true
        bStart = s
        bEnd = e
        bColor = colors[i]
        bCount = 1
        bSourceStart = i
        bDominantDur = width
        bParentEnd = parentEnd
      }
    }

    flush()
  }

  const total = tmpStarts.length
  if (total === 0) {
    return {
      count: 0,
      starts: EMPTY_F32,
      ends: EMPTY_F32,
      depths: EMPTY_U16,
      colors: EMPTY_U32,
      maxEndsPrefix: EMPTY_F32,
      counts: new Uint32Array(0),
      sourceStart: new Uint32Array(0),
      resolutionMs,
    }
  }

  // Per-depth streams are each sorted by `start`; a stable merge across
  // depths reproduces the global sort-by-start invariant the renderer needs
  // for lowerBound culling. Argsort by (start asc, then depth asc) keeps
  // output deterministic when two buckets share a start.
  const order = new Uint32Array(total)
  for (let i = 0; i < total; i++) order[i] = i
  const orderArr: number[] = Array.from(order)
  orderArr.sort((a, b) => {
    const ds = tmpStarts[a] - tmpStarts[b]
    if (ds !== 0) return ds
    return tmpDepths[a] - tmpDepths[b]
  })

  const startsOut = new Float32Array(total)
  const endsOut = new Float32Array(total)
  const depthsOut = new Uint16Array(total)
  const colorsOut = new Uint32Array(total)
  const countsOut = new Uint32Array(total)
  const sourceStartOut = new Uint32Array(total)
  for (let i = 0; i < total; i++) {
    const src = orderArr[i]
    startsOut[i] = tmpStarts[src]
    endsOut[i] = tmpEnds[src]
    depthsOut[i] = tmpDepths[src]
    colorsOut[i] = tmpColors[src]
    countsOut[i] = tmpCounts[src]
    sourceStartOut[i] = tmpSourceStart[src]
  }

  const maxEndsPrefix = new Float32Array(total)
  let running = -Infinity
  for (let i = 0; i < total; i++) {
    const e = endsOut[i]
    if (e > running) running = e
    maxEndsPrefix[i] = running
  }

  return {
    count: total,
    starts: startsOut,
    ends: endsOut,
    depths: depthsOut,
    colors: colorsOut,
    maxEndsPrefix,
    counts: countsOut,
    sourceStart: sourceStartOut,
    resolutionMs,
  }
}

/**
 * Shape that {@link drawFrame} accepts. Either a raw {@link SliceBuffers}
 * (zoomed all the way in, or a track with no mipmap yet) or one
 * {@link SliceMipmapLevel}. Both share the same core arrays; only mipmap
 * levels carry `counts`/`sourceStart`.
 */
export type SliceView = SliceBuffers | SliceMipmapLevel

/**
 * Pick the coarsest level whose resolution still fits one pixel at `pxPerMs`.
 *
 * Zoomed in past every level's resolution we return the *finest* level
 * rather than `mipmap.base`. The finest level is strictly more visible
 * than base at any zoom: wide slices are already singletons with their
 * exact width (so they render identically), and sub-resolution runs are
 * density-merged into rects that never get sub-pixel-culled. Tracks made
 * entirely of sub-ms measures (e.g. Chrome_ChildIOThread in our sample
 * trace) would otherwise vanish the moment the user zoomed past the
 * finest level's threshold, even though nothing in base would be wide
 * enough to render.
 *
 * Base stays reachable via {@link SliceMipmap.base} for the Aggregator /
 * future hit-test layer.
 */
export function pickMipmapLevel(
  mipmap: SliceMipmap | undefined,
  pxPerMs: number,
): SliceView {
  if (!mipmap) return EMPTY_SLICE_BUFFERS
  if (mipmap.levels.length === 0) return mipmap.base
  if (pxPerMs <= 0) return mipmap.levels[mipmap.levels.length - 1]
  const pixelResolutionMs = 1 / pxPerMs
  // Walk coarsest → finest so we pick the largest usable resolution.
  for (let i = mipmap.levels.length - 1; i >= 0; i--) {
    if (mipmap.levels[i].resolutionMs <= pixelResolutionMs) {
      return mipmap.levels[i]
    }
  }
  return mipmap.levels[0]
}

/** Narrow type guard: does this view carry per-bucket density counts? */
export function hasDensityCounts(view: SliceView): view is SliceMipmapLevel {
  return (view as SliceMipmapLevel).counts !== undefined
}
