import {
  hasDensityCounts,
  lowerBoundF32,
  type MarkBuffers,
  type SliceView,
} from '../../core/render/sliceBuffers'
import {unpackColorToCss} from '../../core/render/packColor'
import type {Measure} from '../../core'

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
  /**
   * Back-pointer array for slice-index → Measure lookups during the label
   * pass. Always the base {@link SliceBuffers.measures}; for a mipmap view
   * we translate `sourceStart[i]` through this. Labels are skipped when
   * undefined (e.g. unit tests that don't exercise text).
   */
  baseMeasures?: Measure[]
  /**
   * Absolute ms positions of major gridlines to bleed through the track
   * (full-height strokes). Pre-computed once per frame by
   * {@link CanvasTrackRenderer} via `computeAxisTicks` so every track +
   * the top axis share a single tick grid. Optional: unit tests and
   * other callers can omit it to skip the gridline pass entirely.
   */
  majorGridTicksMs?: Float64Array
  /** Absolute ms positions of minor gridlines. See {@link majorGridTicksMs}. */
  minorGridTicksMs?: Float64Array
}

/** Vertical padding inside a row (mirrors the old DOM renderer). */
const ROW_VPAD_PX = 4

/**
 * Gridline tunables. Subtle-by-default colors so the measures stay the
 * primary visual element; majors are ~30% brighter than minors so the
 * labelled ticks read as anchors without competing with slice colors.
 */
const GRIDLINE_MAJOR_COLOR = 'rgba(160, 174, 192, 0.18)'
const GRIDLINE_MINOR_COLOR = 'rgba(160, 174, 192, 0.08)'

/**
 * Phase 3.5 label pass tunables. Below `LABEL_MIN_WIDTH_PX` the slice rect is
 * too narrow for a single readable glyph, so we skip text entirely; above it
 * we crop the name to the available width and draw a single fillText call.
 */
const LABEL_MIN_WIDTH_PX = 18
const LABEL_PAD_PX = 3
const LABEL_FONT =
  '500 11px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
const LABEL_COLOR = '#0b0f17'
const LABEL_BASELINE: CanvasTextBaseline = 'middle'

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
    baseMeasures,
  } = args

  ctx.clearRect(0, 0, widthCss, heightCss)
  if (pxPerMs <= 0) return

  // --- Gridlines (under everything). ------------------------------------
  // Drawn before measures so slice rects always paint on top. Both
  // passes batch into a single `beginPath` / `stroke` so we pay one
  // rasterization regardless of how many ticks are visible. Xs are
  // snapped to `round(x) + 0.5` so 1-px strokes land inside a single
  // device pixel rather than blurring across two.
  const {majorGridTicksMs, minorGridTicksMs} = args
  if (
    minorGridTicksMs &&
    minorGridTicksMs.length > 0 &&
    pxPerMs > 0
  ) {
    ctx.strokeStyle = GRIDLINE_MINOR_COLOR
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 0; i < minorGridTicksMs.length; i++) {
      const x = (minorGridTicksMs[i] - canvasStartMs) * pxPerMs
      if (x < -1 || x > widthCss + 1) continue
      const xPx = Math.round(x) + 0.5
      ctx.moveTo(xPx, 0)
      ctx.lineTo(xPx, heightCss)
    }
    ctx.stroke()
  }
  if (
    majorGridTicksMs &&
    majorGridTicksMs.length > 0 &&
    pxPerMs > 0
  ) {
    ctx.strokeStyle = GRIDLINE_MAJOR_COLOR
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = 0; i < majorGridTicksMs.length; i++) {
      const x = (majorGridTicksMs[i] - canvasStartMs) * pxPerMs
      if (x < -1 || x > widthCss + 1) continue
      const xPx = Math.round(x) + 0.5
      ctx.moveTo(xPx, 0)
      ctx.lineTo(xPx, heightCss)
    }
    ctx.stroke()
  }

  // --- Measures (filled rects). -----------------------------------------
  // The label pass needs the same per-slice (xCss, wCss, rowYCenter,
  // measureIndex) tuples we just computed for `fillRect`, so we collect them
  // into a scratch buffer during the main loop instead of re-running the
  // culler. Collection is gated on `baseMeasures` being supplied AND the
  // bucket being a singleton wide enough to fit at least one glyph.
  const labelScratch = baseMeasures ? getScratchLabels() : null
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
    // Mipmap singletons need to indirect through `sourceStart` to reach the
    // base measure; raw `SliceBuffers` use `i` directly.
    const sourceStart = densityView?.sourceStart

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

      if (
        labelScratch &&
        bucketCount === 1 &&
        wCss >= LABEL_MIN_WIDTH_PX &&
        baseMeasures
      ) {
        // For a mipmap level we have to translate `sourceStart[i]` through
        // `baseMeasures`; for raw SliceBuffers `i` is already the base index.
        const baseIdx = sourceStart ? sourceStart[i] : i
        const measure = baseMeasures[baseIdx]
        if (measure !== undefined) {
          labelScratch.push({
            x: xCss,
            y: y + rowH / 2,
            w: wCss,
            h: rowH,
            name: measure.name,
          })
        }
      }
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

  // --- Slice labels (Phase 3.5). ---------------------------------------
  // Drawn after every fillRect pass so the glyphs sit on top of their
  // rects. One ctx.font / textBaseline / fillStyle assignment for the
  // whole pass — measureText and cropText results are cached across
  // frames so wide traces don't re-shape strings every paint.
  if (labelScratch && labelScratch.length > 0) {
    ctx.font = LABEL_FONT
    ctx.textBaseline = LABEL_BASELINE
    ctx.fillStyle = LABEL_COLOR
    for (let i = 0; i < labelScratch.length; i++) {
      const item = labelScratch[i]
      const avail = item.w - 2 * LABEL_PAD_PX
      if (avail <= 0) continue
      const text = cropText(ctx, item.name, avail)
      if (text.length === 0) continue
      ctx.fillText(text, item.x + LABEL_PAD_PX, item.y)
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

interface LabelItem {
  /** Slice rect left edge in CSS px, relative to canvas. */
  x: number
  /** Vertical text baseline center in CSS px, matches `LABEL_BASELINE`. */
  y: number
  /** Slice rect width in CSS px. Used to gate + crop. */
  w: number
  /** Slice rect height in CSS px. Reserved for future centering work. */
  h: number
  name: string
}

const LABEL_SCRATCH: LabelItem[] = []
function getScratchLabels(): LabelItem[] {
  LABEL_SCRATCH.length = 0
  return LABEL_SCRATCH
}

// `ctx.measureText` is the dominant cost of the label pass. Cache by name
// (font is frame-constant so it doesn't enter the key) and by (name, available
// width) for the cropped result. The full-width cache is shared across frames,
// so static measure names parse once for the lifetime of the page.
const measureCache = new Map<string, number>()
const cropCache = new Map<string, string>()
const ELLIPSIS = '…'

/**
 * Trim `name` so it fits in `availPx`, preferring the full string when
 * possible. Uses a cached `measureText` result for the full string and a
 * binary search over character indices when truncation is needed.
 *
 * Width queries during the binary search aren't memoized (they're per-prefix,
 * unbounded) but the final cropped string IS memoized, so subsequent frames
 * with the same `(name, ⌊availPx⌋)` skip the search entirely.
 */
function cropText(
  ctx: CanvasRenderingContext2D,
  name: string,
  availPx: number,
): string {
  if (name.length === 0 || availPx <= 0) return ''
  let fullWidth = measureCache.get(name)
  if (fullWidth === undefined) {
    fullWidth = ctx.measureText(name).width
    measureCache.set(name, fullWidth)
  }
  if (fullWidth <= availPx) return name

  const cropKey = `${name}|${Math.floor(availPx)}`
  const cached = cropCache.get(cropKey)
  if (cached !== undefined) return cached

  const ellipsisWidth = ctx.measureText(ELLIPSIS).width
  if (ellipsisWidth >= availPx) {
    cropCache.set(cropKey, '')
    return ''
  }

  // Binary search the largest prefix length whose width + ellipsis fits.
  let lo = 0
  let hi = name.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1
    const w = ctx.measureText(name.slice(0, mid)).width + ellipsisWidth
    if (w <= availPx) lo = mid
    else hi = mid - 1
  }
  const result = lo === 0 ? '' : name.slice(0, lo) + ELLIPSIS
  cropCache.set(cropKey, result)
  return result
}

// Visible for tests.
export const __test__ = {
  quantizeAlpha,
  ALPHA_STOPS,
  styleForBatch,
  cropText,
  measureCache,
  cropCache,
}
