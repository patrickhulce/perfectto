import type {AppliedPersona} from '../personas/types'
import type {Timeline} from '../types'

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
 * Build per-category stacked bands for the overview chart. Mirrors
 * {@link buildOverviewUtilization}'s bucketing logic but splits the
 * depth-0 wall-clock contribution across persona-assigned bands.
 *
 *   - Measures whose resolved category maps to a band accumulate into
 *     that band's bucket.
 *   - Measures with no band (or no category) are dropped — they
 *     implicitly become "idle" in the stacked chart.
 *   - Same `1 / (bucketMs * trackCount)` normalization, so bands sum
 *     to ≤ 1 when all tracks are busy and well-categorized.
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

  let trackCount = 0
  for (const system of timeline.systems) {
    for (const track of system.tracks) {
      trackCount += 1
      const buffers = track.buffers
      if (!buffers || buffers.count === 0) continue
      const count = buffers.count
      const starts = buffers.starts
      const ends = buffers.ends
      const depths = buffers.depths
      const measures = buffers.measures

      for (let i = 0; i < count; i++) {
        if (depths[i] !== 0) continue
        const catId = applied.resolveCategoryId(measures[i], track, system)
        if (catId === undefined) continue
        const bandIdx = bandForCategoryIdx.get(catId)
        if (bandIdx === undefined) continue

        const s = starts[i]
        const e = ends[i]
        if (e <= startMs || s >= endMs) continue
        const s2 = s < startMs ? startMs : s
        const e2 = e > endMs ? endMs : e
        const firstBucket = Math.max(0, Math.floor((s2 - startMs) / bucketMs))
        const lastBucketRaw = Math.floor((e2 - startMs) / bucketMs)
        const lastBucket = Math.min(n - 1, e2 === endMs ? n - 1 : lastBucketRaw)

        const target = raw[bandIdx]
        if (firstBucket === lastBucket) {
          target[firstBucket] += e2 - s2
          continue
        }
        const firstBucketEnd = startMs + (firstBucket + 1) * bucketMs
        target[firstBucket] += firstBucketEnd - s2
        for (let b = firstBucket + 1; b < lastBucket; b++) {
          target[b] += bucketMs
        }
        const lastBucketStart = startMs + lastBucket * bucketMs
        target[lastBucket] += e2 - lastBucketStart
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
