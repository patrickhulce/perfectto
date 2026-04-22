import type {AppliedPersona} from '../personas/types'
import type {Measure, System, Timeline, Track} from '../types'

/**
 * Per-band, per-bucket utilization signal for the stacked overview
 * chart. Parallel to {@link OverviewUtilization}:
 *
 *   - same bucket count, same `startMs`/`endMs` span,
 *   - each band's `buckets[i] ∈ [0, 1]` after normalization,
 *   - bands sum to ≤ 1 (the residual is "idle / unaccounted").
 *
 * The band array is ordered as in {@link AppliedPersona.bands}, which
 * the renderer stacks bottom-up.
 */
export interface OverviewBandsResult {
  startMs: number
  endMs: number
  bucketMs: number
  bucketCount: number
  bands: OverviewBandSeries[]
}

export interface OverviewBandSeries {
  id: string
  label: string
  color: string
  buckets: Float32Array
}

const DEFAULT_BUCKET_COUNT = 2048

/**
 * Build per-category stacked bands for the overview chart.
 *
 * Aggregation is *self-time*, not depth-0 wall time: each measure
 * contributes the portion of its duration that isn't already covered
 * by one of its children, to its own resolved category's band. This is
 * essential for Chrome-style traces where a `RunTask` (system / gray)
 * wraps an `EvaluateScript` (scripting / yellow) that wraps user JS —
 * depth-0-only counting would show the whole thing as gray even though
 * the actual work is yellow. Walking the full tree and giving each
 * moment of wall time to the *deepest* measure that owns it produces
 * the DevTools-style coloured silhouette.
 *
 *   - Categories that don't map to any overview band (idle / other /
 *     uncategorized) drop out; their wall time becomes unaccounted
 *     residual between the stacked bands.
 *   - Gaps between top-level (depth-0) siblings are not attributed
 *     to any band — there's no parent to own them — so a truly idle
 *     main thread reads as a dark gap, matching DevTools.
 *   - Same `1 / (bucketMs * trackCount)` normalization as before, so
 *     a single busy track saturates its band at 1.0 per bucket.
 *
 * A small Gaussian smoothing pass runs per band so the stacked
 * silhouette matches the single-curve overview's visual smoothness.
 */
export function buildOverviewBands(
  timeline: Timeline,
  applied: AppliedPersona,
  bucketCount: number = DEFAULT_BUCKET_COUNT,
): OverviewBandsResult {
  const startMs = timeline.start
  const endMs = timeline.end
  const span = Math.max(0, endMs - startMs)
  const n = Math.max(1, bucketCount | 0)

  const bands: OverviewBandSeries[] = applied.bands.map(b => ({
    id: b.id,
    label: b.label,
    color: b.color,
    buckets: new Float32Array(n),
  }))

  if (span <= 0 || bands.length === 0) {
    return {
      startMs,
      endMs,
      bucketMs: span > 0 ? span / n : 0,
      bucketCount: n,
      bands,
    }
  }

  const bucketMs = span / n

  // Index: bandId -> bands[] position, categoryId -> bandIndex (or -1).
  const bandIndexById = new Map<string, number>()
  bands.forEach((b, i) => bandIndexById.set(b.id, i))
  const bandForCategoryIdx = new Map<string, number>()
  for (const [catId, bandId] of Object.entries(applied.bandForCategory)) {
    const idx = bandIndexById.get(bandId)
    if (idx !== undefined) bandForCategoryIdx.set(catId, idx)
  }

  // Per-band raw accumulators, kept in Float64 for numerical headroom
  // during the accumulation pass, then projected into the Float32
  // output arrays at normalization.
  const raw: Float64Array[] = bands.map(() => new Float64Array(n))

  const accumulate = (bandIdx: number, s: number, e: number): void => {
    if (bandIdx < 0) return
    if (e <= s) return
    if (e <= startMs || s >= endMs) return
    const s2 = s < startMs ? startMs : s
    const e2 = e > endMs ? endMs : e
    const firstBucket = Math.max(0, Math.floor((s2 - startMs) / bucketMs))
    const lastBucketRaw = Math.floor((e2 - startMs) / bucketMs)
    const lastBucket = Math.min(n - 1, e2 === endMs ? n - 1 : lastBucketRaw)
    const target = raw[bandIdx]
    if (firstBucket === lastBucket) {
      target[firstBucket] += e2 - s2
      return
    }
    const firstBucketEnd = startMs + (firstBucket + 1) * bucketMs
    target[firstBucket] += firstBucketEnd - s2
    for (let b = firstBucket + 1; b < lastBucket; b++) {
      target[b] += bucketMs
    }
    const lastBucketStart = startMs + lastBucket * bucketMs
    target[lastBucket] += e2 - lastBucketStart
  }

  const visit = (measure: Measure, track: Track, system: System): void => {
    const catId = applied.resolveCategoryId(measure, track, system)
    const bandIdx =
      catId !== undefined ? bandForCategoryIdx.get(catId) ?? -1 : -1
    // Self-time: walk children in start-order and attribute any gap
    // between the running cursor and the next child's start to *this*
    // measure's band. Children are sorted and non-overlapping by
    // construction (finalizeContainer), so a single left-to-right pass
    // is enough.
    let cursor = measure.start
    const kids = measure.measures
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]
      if (cursor < child.start) {
        accumulate(bandIdx, cursor, child.start)
      }
      visit(child, track, system)
      if (child.end > cursor) cursor = child.end
    }
    if (cursor < measure.end) {
      accumulate(bandIdx, cursor, measure.end)
    }
  }

  // Aggregate only over `applied.overviewSystems` — the persona-declared
  // subset of visible tracks that matter enough to paint into the
  // overview (for Web Dev this is the Main thread alone). Falling back
  // to every visible track, like we used to, washes the stacked chart
  // out: a collapsed Compositor / IOThread / ThreadPool worker can post
  // hundreds of small painting/system slices that dilute the main
  // thread's silhouette and make the overview look flat. Scoping to
  // what the user is reading keeps the bands aligned with the flame
  // chart.
  let trackCount = 0
  for (const system of applied.overviewSystems) {
    for (const track of system.tracks) {
      trackCount += 1
      for (const measure of track.measures) {
        visit(measure, track, system)
      }
    }
  }

  if (trackCount === 0) {
    return {startMs, endMs, bucketMs, bucketCount: n, bands}
  }

  const norm = 1 / (bucketMs * trackCount)
  for (let bi = 0; bi < bands.length; bi++) {
    const src = raw[bi]
    const dst = bands[bi].buckets
    for (let i = 0; i < n; i++) {
      const v = src[i] * norm
      dst[i] = v > 1 ? 1 : v < 0 ? 0 : v
    }
    bands[bi].buckets = gaussianSmooth(dst)
  }

  return {startMs, endMs, bucketMs, bucketCount: n, bands}
}

// Same 7-tap kernel as overviewUtilization for visual consistency.
const KERNEL = [0.00598, 0.060626, 0.241843, 0.383103, 0.241843, 0.060626, 0.00598]
const KERNEL_RADIUS = (KERNEL.length - 1) >> 1

function gaussianSmooth(input: Float32Array): Float32Array {
  const n = input.length
  if (n === 0) return input
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    let weight = 0
    for (let k = -KERNEL_RADIUS; k <= KERNEL_RADIUS; k++) {
      const j = i + k
      if (j < 0 || j >= n) continue
      const w = KERNEL[k + KERNEL_RADIUS]
      sum += input[j] * w
      weight += w
    }
    out[i] = weight > 0 ? sum / weight : 0
  }
  return out
}
