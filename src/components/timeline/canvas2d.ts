import {
  hasDensityCounts,
  lowerBoundF32,
  type MarkBuffers,
  type SliceView,
} from '../../core/render/sliceBuffers'
import {unpackColorToCss} from '../../core/render/packColor'

export interface DrawFrameArgs {
  ctx: CanvasRenderingContext2D
  /**
   * What to draw. Either the raw {@link SliceBuffers} for the track (zoomed
   * in past the finest mipmap level, or when no mipmap is present) or one
   * {@link SliceMipmapLevel} of density-tinted buckets.
   */
  slices: SliceView
  marks: MarkBuffers
  /** Width of the canvas in CSS pixels (pre-DPR). */
  widthCss: number
  /** Height of the canvas in CSS pixels (pre-DPR). */
  heightCss: number
  /** Row height per depth level in CSS pixels. */
  rowHeight: number
  pxPerMs: number
  /** Left edge of the visible window, in timeline ms. */
  visibleStartMs: number
  /** Right edge of the visible window, in timeline ms. */
  visibleEndMs: number
  /**
   * Offset in ms that should map to x=0 on the canvas. Usually
   * `visibleStartMs - overdrawMs` so we can pre-render a bit outside the
   * viewport and compositor-translate later (Phase 3).
   */
  canvasStartMs: number
  /**
   * When the user collapses a track, we only draw the top row of measures
   * (depth 0). Deeper slices are fully culled so CPU cost scales with the
   * visible row count, not the underlying tree depth.
   */
  maxDepthExclusive: number
}

/** Vertical padding inside a row (mirrors the old DOM renderer). */
const ROW_VPAD_PX = 4

/**
 * Density alpha stops for merged mipmap buckets. Keyed on
 * `min(ALPHA_STOPS.length - 1, floor(log2(count)))`. Denser buckets render
 * *lighter* so hotspot density is legible against the dark UI without
 * producing an indistinguishable dark blob.
 *
 * Index 0 is the opaque stop — it's what singleton buckets and raw slices
 * get. Indices 1..4 are reserved for merged buckets where `count >= 2`.
 */
const ALPHA_STOPS = [1.0, 0.75, 0.55, 0.4, 0.28] as const
const ALPHA_OPAQUE = 0

function quantizeAlpha(count: number): number {
  if (count <= 1) return ALPHA_OPAQUE
  // floor(log2(count)) clamped into [1, ALPHA_STOPS.length - 1].
  let stop = 0
  let c = count
  while (c > 1 && stop < ALPHA_STOPS.length - 1) {
    c >>>= 1
    stop += 1
  }
  return stop
}

/**
 * Batched fillRect renderer. Groups slices by packed color AND density stop
 * so we only assign `ctx.fillStyle` once per (color, alpha) pair, which is
 * the dominant cost for large traces (setting fillStyle re-parses the color
 * every time).
 *
 * Complexity per frame: O(visible_slices), with visible_slices bounded by
 * (viewport_px) once slices narrower than 1px are dropped. On a mipmap
 * level it's bounded by that level's bucket count, which Phase 2 caps at a
 * few hundred.
 */
export function drawFrame(args: DrawFrameArgs): void {
  const {
    ctx,
    slices,
    marks,
    widthCss,
    heightCss,
    rowHeight,
    pxPerMs,
    visibleStartMs,
    visibleEndMs,
    canvasStartMs,
    maxDepthExclusive,
  } = args

  ctx.clearRect(0, 0, widthCss, heightCss)
  if (pxPerMs <= 0) return

  // --- Measures (filled rects). -----------------------------------------
  if (slices.count > 0) {
    // Binary-search the running-max-of-ends prefix to find the earliest
    // index whose slice could still reach into the viewport. Everything
    // before that is guaranteed to end before visibleStartMs and can be
    // skipped entirely. This correctly preserves long-spanning ancestor
    // slices (e.g. a depth-0 parent covering the whole track) even when
    // hundreds of their shorter descendants sit between them and the
    // viewport in the sorted `starts` array.
    const first = lowerBoundF32(
      slices.maxEndsPrefix,
      slices.count,
      visibleStartMs,
    )

    const batches = getScratchBatches()
    const densityView = hasDensityCounts(slices) ? slices : null
    const counts = densityView?.counts

    const rowH = rowHeight - ROW_VPAD_PX
    const starts = slices.starts
    const ends = slices.ends
    const depths = slices.depths
    const colors = slices.colors
    const count = slices.count

    for (let i = first; i < count; i++) {
      const s = starts[i]
      if (s > visibleEndMs) break
      const e = ends[i]
      if (e < visibleStartMs) continue
      const d = depths[i]
      if (d >= maxDepthExclusive) continue
      const xCss = (s - canvasStartMs) * pxPerMs
      const wCssRaw = (e - s) * pxPerMs
      const bucketCount = counts ? counts[i] : 1
      // Merged buckets span at least one full level-resolution by
      // construction, so they always clear the 1px threshold. Sub-pixel
      // culling only applies to singletons (raw slices or wide-enough
      // mipmap passthroughs).
      if (bucketCount === 1 && wCssRaw < 1) continue
      const wCss = wCssRaw < 1.5 ? 1 : wCssRaw
      const y = d * rowHeight + ROW_VPAD_PX / 2
      const alphaStop = counts ? quantizeAlpha(bucketCount) : ALPHA_OPAQUE
      // Pack (color, alphaStop) into one number so we can key a Map<number>
      // without string concat per slice. 3 bits of alphaStop is plenty.
      const batchKey = (colors[i] >>> 0) * 8 + alphaStop
      let batch = batches.get(batchKey)
      if (!batch) {
        batch = {x: [], y: [], w: [], h: [], color: colors[i], alphaStop}
        batches.set(batchKey, batch)
      }
      batch.x.push(xCss)
      batch.y.push(y)
      batch.w.push(wCss)
      batch.h.push(rowH)
    }

    for (const batch of batches.values()) {
      ctx.fillStyle = styleForBatch(batch.color, batch.alphaStop)
      const len = batch.x.length
      for (let k = 0; k < len; k++) {
        ctx.fillRect(batch.x[k], batch.y[k], batch.w[k], batch.h[k])
      }
    }
  }

  // --- Marks (2px vertical ticks). --------------------------------------
  if (marks.count > 0) {
    const first = Math.max(
      0,
      lowerBoundF32(marks.times, marks.count, visibleStartMs) - 1,
    )
    const batches = getScratchBatches()

    const times = marks.times
    const mDepths = marks.depths
    const mColors = marks.colors
    const count = marks.count
    for (let i = first; i < count; i++) {
      const t = times[i]
      if (t > visibleEndMs) break
      if (t < visibleStartMs) continue
      const d = mDepths[i]
      if (d >= maxDepthExclusive) continue
      const xCss = (t - canvasStartMs) * pxPerMs - 1
      const y = d * rowHeight + 2
      const h = rowHeight
      const color = mColors[i]
      const batchKey = (color >>> 0) * 8 + ALPHA_OPAQUE
      let batch = batches.get(batchKey)
      if (!batch) {
        batch = {x: [], y: [], w: [], h: [], color, alphaStop: ALPHA_OPAQUE}
        batches.set(batchKey, batch)
      }
      batch.x.push(xCss)
      batch.y.push(y)
      batch.w.push(2)
      batch.h.push(h)
    }

    for (const batch of batches.values()) {
      ctx.fillStyle = styleForBatch(batch.color, batch.alphaStop)
      const len = batch.x.length
      for (let k = 0; k < len; k++) {
        ctx.fillRect(batch.x[k], batch.y[k], batch.w[k], batch.h[k])
      }
    }
  }
}

function styleForBatch(packedColor: number, alphaStop: number): string {
  if (alphaStop === ALPHA_OPAQUE) return unpackColorToCss(packedColor)
  const r = (packedColor >>> 24) & 0xff
  const g = (packedColor >>> 16) & 0xff
  const b = (packedColor >>> 8) & 0xff
  const baseA = (packedColor & 0xff) / 255
  const a = baseA * ALPHA_STOPS[alphaStop]
  return `rgba(${r},${g},${b},${a.toFixed(3)})`
}

interface Batch {
  x: number[]
  y: number[]
  w: number[]
  h: number[]
  color: number
  alphaStop: number
}

// A single renderer only draws on the main thread, so a module-level scratch
// map is safe. We clear it at the top of every use to avoid carrying state
// between tracks.
const SCRATCH: Map<number, Batch> = new Map()
function getScratchBatches(): Map<number, Batch> {
  for (const batch of SCRATCH.values()) {
    batch.x.length = 0
    batch.y.length = 0
    batch.w.length = 0
    batch.h.length = 0
  }
  SCRATCH.clear()
  return SCRATCH
}

// Visible for tests.
export const __test__ = {quantizeAlpha, ALPHA_STOPS, styleForBatch}
