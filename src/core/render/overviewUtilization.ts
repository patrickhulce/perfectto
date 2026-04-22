import type {System, Timeline} from '../types'

/**
 * Output of {@link buildOverviewUtilization}. Represents a smoothed
 * per-bucket utilization signal covering the entire trace span, suitable
 * for driving a mountain/area chart in the overview track.
 *
 * `buckets[i]` is in `[0, 1]` after normalization and smoothing. A value
 * of `1.0` means "every track had a depth-0 slice running for the whole
 * bucket"; `0` means "nothing ran in this bucket".
 */
export interface OverviewUtilization {
  buckets: Float32Array
  bucketMs: number
  startMs: number
  endMs: number
}

const DEFAULT_BUCKET_COUNT = 2048

/**
 * Build the smoothed overall utilization signal for the overview track.
 *
 * Approach:
 *  - Slice the full trace span into `bucketCount` equal-width buckets.
 *  - For every track, iterate its flat `buffers` SOA and accumulate
 *    overlap with each bucket, counting **only depth-0 slices**. Nested
 *    children are already subsumed by their parent's duration, so
 *    counting deeper depths would multi-count the same wall-clock work
 *    and produce values that saturate past 1.0.
 *  - Normalize by `bucketMs * trackCount` so saturation means "every
 *    track was busy the whole bucket" = 1.0.
 *  - Apply a small Gaussian smoothing (7-tap, sigma ≈ 1.4) to soften
 *    the binning artifacts and produce the "mountain" silhouette.
 *
 * Cost: O(totalDepth0Slices) plus O(bucketCount) for the smoothing pass.
 * For our target trace sizes (up to ~1M slices) this runs well under a
 * frame on the main thread.
 */
export function buildOverviewUtilization(
  timeline: Timeline,
  bucketCount: number = DEFAULT_BUCKET_COUNT,
  /**
   * Optional override for the systems the signal should aggregate over.
   * Callers with an applied persona pass `appliedPersona.systems` so
   * tracks the persona hides (async / plumbing) don't paint into the
   * overview. Defaults to the raw trace's full system list, which is
   * the right thing for the Raw persona / no-persona case.
   */
  systems: readonly System[] = timeline.systems,
): OverviewUtilization {
  const startMs = timeline.start
  const endMs = timeline.end
  const span = Math.max(0, endMs - startMs)
  const n = Math.max(1, bucketCount | 0)

  if (span <= 0) {
    return {buckets: new Float32Array(n), bucketMs: 0, startMs, endMs}
  }

  const bucketMs = span / n
  const raw = new Float64Array(n)

  let trackCount = 0
  for (const system of systems) {
    for (const track of system.tracks) {
      trackCount += 1
      const buffers = track.buffers
      if (!buffers || buffers.count === 0) continue
      const count = buffers.count
      const starts = buffers.starts
      const ends = buffers.ends
      const depths = buffers.depths

      for (let i = 0; i < count; i++) {
        if (depths[i] !== 0) continue
        const s = starts[i]
        const e = ends[i]
        if (e <= startMs || s >= endMs) continue
        const s2 = s < startMs ? startMs : s
        const e2 = e > endMs ? endMs : e
        // Find the bucket range this slice spans and distribute its
        // wall-clock contribution per bucket.
        const firstBucket = Math.max(
          0,
          Math.floor((s2 - startMs) / bucketMs),
        )
        const lastBucketRaw = Math.floor((e2 - startMs) / bucketMs)
        // A slice that ends exactly on a bucket boundary should not
        // contribute to the next bucket; clamp and treat end-aligned as
        // inclusive of the previous bucket only.
        const lastBucket = Math.min(
          n - 1,
          e2 === endMs ? n - 1 : lastBucketRaw,
        )

        if (firstBucket === lastBucket) {
          raw[firstBucket] += e2 - s2
          continue
        }

        const firstBucketEnd = startMs + (firstBucket + 1) * bucketMs
        raw[firstBucket] += firstBucketEnd - s2
        for (let b = firstBucket + 1; b < lastBucket; b++) {
          raw[b] += bucketMs
        }
        const lastBucketStart = startMs + lastBucket * bucketMs
        raw[lastBucket] += e2 - lastBucketStart
      }
    }
  }

  const out = new Float32Array(n)
  if (trackCount === 0) {
    return {buckets: out, bucketMs, startMs, endMs}
  }

  // Normalize to [0, 1]. Cap at 1 defensively — overlapping depth-0
  // slices inside a single track (which shouldn't happen for well-formed
  // traces but we don't enforce it in the type) could push a bucket
  // over 1.
  const norm = 1 / (bucketMs * trackCount)
  for (let i = 0; i < n; i++) {
    const v = raw[i] * norm
    out[i] = v > 1 ? 1 : v < 0 ? 0 : v
  }

  return {buckets: gaussianSmooth(out), bucketMs, startMs, endMs}
}

/**
 * 7-tap Gaussian kernel (sigma ≈ 1.4). Kept small enough that the pass
 * stays cheap on any trace size and the mountain silhouette still
 * tracks real spikes rather than blurring them into a flat hill.
 */
const KERNEL = [
  0.00598, 0.060626, 0.241843, 0.383103, 0.241843, 0.060626, 0.00598,
]
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
    // Renormalize at the edges so the first/last few samples don't dim
    // from truncation of the kernel.
    out[i] = weight > 0 ? sum / weight : 0
  }
  return out
}

// Visible for tests.
export const __test__ = {gaussianSmooth, DEFAULT_BUCKET_COUNT}
