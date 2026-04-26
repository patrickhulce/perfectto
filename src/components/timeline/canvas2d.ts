import {
  SLICE_FLAG_COMPACTED,
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

/**
 * Inputs for the overlay canvas's highlight draw. Mirrors the per-frame
 * subset of {@link DrawFrameArgs} that drives positioning (viewport, DPR-
 * independent CSS geometry, mipmap level), plus the tree-highlight region
 * the caller wants drawn on top at full opacity. Gridlines, marks, and
 * non-highlighted slices all belong on the base canvas — this function
 * only ever paints the anchor slice plus its pre-order descendants.
 */
export interface DrawHighlightFrameArgs {
  ctx: CanvasRenderingContext2D
  slices: SliceView
  widthCss: number
  heightCss: number
  rowHeight: number
  pxPerMs: number
  visibleStartMs: number
  visibleEndMs: number
  canvasStartMs: number
  maxDepthExclusive: number
  baseMeasures?: Measure[]
  /**
   * Tree region to repaint at full opacity. Slices fully contained in
   * `[startMs, endMs]` at `depth >= minDepth` are the pre-order
   * descendants of the anchor (including the anchor itself).
   */
  highlight: {
    startMs: number
    endMs: number
    /** Inclusive minimum depth; the anchor's own depth. */
    minDepth: number
  }
}

/** Vertical padding inside a row (mirrors the old DOM renderer). */
const ROW_VPAD_PX = 4

/**
 * Translucent diagonal-stripe overlay drawn on top of any slice whose
 * `flags & SLICE_FLAG_COMPACTED` is set. Subtle enough that the
 * underlying color still reads at a glance, distinct enough that the
 * user can tell "this rect represents folded detail" vs. a leaf.
 */
const STRIPE_FALLBACK_FILL = 'rgba(255, 255, 255, 0.18)'
const STRIPE_PATTERN_SIZE = 8
const STRIPE_LINE_COLOR = 'rgba(255, 255, 255, 0.35)'
const STRIPE_LINE_WIDTH = 1.5

/**
 * Lazily-built `CanvasPattern` for the compaction stripe overlay.
 * Cached per source ctx because `CanvasPattern` instances are tied to
 * a specific 2D context — reusing one across contexts works in
 * Chrome/Firefox today but isn't spec-guaranteed, and jsdom in tests
 * returns `null` from `createPattern`, which we want to fall back from
 * gracefully without spamming `createPattern` calls every frame.
 */
const STRIPE_PATTERN_CACHE = new WeakMap<
  CanvasRenderingContext2D,
  CanvasPattern | null
>()

function ensureStripePattern(
  ctx: CanvasRenderingContext2D,
): CanvasPattern | null {
  const cached = STRIPE_PATTERN_CACHE.get(ctx)
  if (cached !== undefined) return cached
  // Some test mocks omit `createPattern` entirely; treat that as a
  // permanent miss so the renderer falls back to a flat tint instead
  // of throwing on every frame.
  if (typeof ctx.createPattern !== 'function') {
    STRIPE_PATTERN_CACHE.set(ctx, null)
    return null
  }
  // OffscreenCanvas covers every browser we render in (Chromium 69+,
  // Firefox 105+, Safari 16.4+) and avoids touching the DOM. In
  // environments without it (jsdom in tests, ancient Safari) we
  // skip the pattern build entirely and let the caller fall back to
  // a flat tint — visually weaker but functionally correct.
  if (typeof OffscreenCanvas === 'undefined') {
    STRIPE_PATTERN_CACHE.set(ctx, null)
    return null
  }
  const off = new OffscreenCanvas(STRIPE_PATTERN_SIZE, STRIPE_PATTERN_SIZE)
  const pctx = off.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | null
  if (pctx) {
    pctx.clearRect(0, 0, STRIPE_PATTERN_SIZE, STRIPE_PATTERN_SIZE)
    pctx.strokeStyle = STRIPE_LINE_COLOR
    pctx.lineWidth = STRIPE_LINE_WIDTH
    pctx.beginPath()
    // Two diagonals + a wraparound segment so the pattern tiles seamlessly.
    pctx.moveTo(-1, STRIPE_PATTERN_SIZE + 1)
    pctx.lineTo(STRIPE_PATTERN_SIZE + 1, -1)
    pctx.moveTo(-1, 1)
    pctx.lineTo(1, -1)
    pctx.moveTo(STRIPE_PATTERN_SIZE - 1, STRIPE_PATTERN_SIZE + 1)
    pctx.lineTo(STRIPE_PATTERN_SIZE + 1, STRIPE_PATTERN_SIZE - 1)
    pctx.stroke()
  }
  const pattern = ctx.createPattern(
    off as unknown as CanvasImageSource,
    'repeat',
  )
  STRIPE_PATTERN_CACHE.set(ctx, pattern)
  return pattern
}

/**
 * Emit a single overlay pass over `rects` using the cached stripe
 * pattern. Falls back to a flat translucent white tint when the
 * environment can't produce a pattern (jsdom tests).
 */
function paintStripeOverlay(
  ctx: CanvasRenderingContext2D,
  rects: ReadonlyArray<{x: number; y: number; w: number; h: number}>,
): void {
  if (rects.length === 0) return
  const pattern = ensureStripePattern(ctx)
  ctx.fillStyle = pattern ?? STRIPE_FALLBACK_FILL
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]
    ctx.fillRect(r.x, r.y, r.w, r.h)
  }
}

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
 * Batched fillRect renderer. Groups slices by packed color so we only
 * assign `ctx.fillStyle` once per distinct color per frame, which is the
 * dominant cost for large traces (setting fillStyle re-parses the color
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
  //
  // Dimming for the tree-highlight affordance now lives OUTSIDE this
  // function: the bottom canvas (which calls drawFrame) is CSS-dimmed to
  // 0.75 via `opacity`, and a sibling overlay canvas renders the
  // highlighted tree at full opacity on top (see drawHighlightFrame).
  // This function is a straight single-pass renderer — no alpha
  // manipulation, no containment predicate.
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

    // One batch per distinct color — setting ctx.fillStyle is the dominant
    // per-call cost in this path, so coalescing all rects of the same color
    // into a single assignment is the win.
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
    const flags = slices.flags
    const count = slices.count
    // Compacted-slice rects collected while we walk the visible window;
    // emitted as a single overlay pass after the color batches paint so
    // the stripe sits on top of the base color without altering it.
    const stripeScratch = getScratchStripes()

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
      const batchKey = colors[i] >>> 0
      let batch = batches.get(batchKey)
      if (!batch) {
        batch = {x: [], y: [], w: [], h: [], color: colors[i]}
        batches.set(batchKey, batch)
      }
      batch.x.push(xCss)
      batch.y.push(y)
      batch.w.push(wCss)
      batch.h.push(rowH)

      if (flags[i] & SLICE_FLAG_COMPACTED) {
        stripeScratch.push({x: xCss, y, w: wCss, h: rowH})
      }

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
      ctx.fillStyle = unpackColorToCss(batch.color)
      const len = batch.x.length
      for (let k = 0; k < len; k++) {
        ctx.fillRect(batch.x[k], batch.y[k], batch.w[k], batch.h[k])
      }
    }

    // Stripe overlay sits on top of the color fill; the pattern's alpha
    // lets the underlying color show through so users still read the
    // category at a glance.
    paintStripeOverlay(ctx, stripeScratch)
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
      const batchKey = color >>> 0
      let batch = batches.get(batchKey)
      if (!batch) {
        batch = {x: [], y: [], w: [], h: [], color}
        batches.set(batchKey, batch)
      }
      batch.x.push(xCss)
      batch.y.push(y)
      batch.w.push(2)
      batch.h.push(h)
    }

    for (const batch of batches.values()) {
      ctx.fillStyle = unpackColorToCss(batch.color)
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
  // frames so wide traces don't re-shape strings every paint. The
  // canvas-wide CSS opacity (applied by CanvasTrackRenderer when no
  // highlight is active) dims labels with their rects.
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

/**
 * Overlay draw. Clears `ctx` and paints only the slices whose span is
 * fully contained in the highlight range at `depth >= minDepth` — i.e.
 * the anchor slice plus its pre-order descendants. Runs on a separate
 * canvas stacked over the (CSS-dimmed) base canvas, so the highlighted
 * tree visually sits at full opacity against a 0.75-dimmed background.
 *
 * Gridlines, marks, non-highlighted slices, and the "dim" pass all live
 * on the base canvas via {@link drawFrame}; this function owns none of
 * them. Labels for wide singletons inside the tree are still emitted so
 * they read at full opacity, matching the rects they sit on.
 */
export function drawHighlightFrame(args: DrawHighlightFrameArgs): void {
  const {
    ctx,
    slices,
    widthCss,
    heightCss,
    rowHeight,
    pxPerMs,
    visibleStartMs,
    visibleEndMs,
    canvasStartMs,
    maxDepthExclusive,
    baseMeasures,
    highlight,
  } = args

  ctx.clearRect(0, 0, widthCss, heightCss)
  if (pxPerMs <= 0 || slices.count === 0) return

  // `starts[i]` / `ends[i]` come from Float32Arrays. The highlight
  // bounds arrive as F64 doubles from the hovered / selected Measure.
  // Snap them into F32 so the containment test compares values in a
  // single precision regime. Without this:
  //   - the anchor's own F32 `starts[anchorIdx]` can be microscopically
  //     less than its F64 `startMs`, so `s >= hiStart` fails for the
  //     anchor and the whole subtree drops out;
  //   - an adjacent sibling whose F64 end sits past the anchor's F64
  //     end still passes `e <= hiEnd` after F32 rounding, so a bar
  //     spanning into the parent's region gets painted.
  const hiStart = Math.fround(highlight.startMs)
  const hiEnd = Math.fround(highlight.endMs)
  const hiMinDepth = highlight.minDepth

  const first = lowerBoundF32(
    slices.maxEndsPrefix,
    slices.count,
    visibleStartMs,
  )

  const densityView = hasDensityCounts(slices) ? slices : null
  const counts = densityView?.counts
  const sourceStart = densityView?.sourceStart

  const rowH = rowHeight - ROW_VPAD_PX
  const starts = slices.starts
  const ends = slices.ends
  const depths = slices.depths
  const colors = slices.colors
  const flags = slices.flags
  const count = slices.count
  const labelScratch = baseMeasures ? getScratchLabels() : null
  const stripeScratch = getScratchStripes()

  // Match the base's color-batching z-order, exactly. Here's why: the
  // base's drawFrame groups rects by `colors[i]` and emits batches in
  // first-seen-color order. The `Map.values()` iteration then paints
  // all rects of the first-seen color, then the next, and so on. For a
  // typical viewport this means broad ancestor categories (System,
  // Other — gray) get seen early in the start-sorted scan and end up
  // as the *first* batch — i.e. painted *first*, i.e. covered by later
  // batches (mint, yellow…). The user sees solid-mint rows because
  // mint is batched later than the greys underneath it.
  //
  // The overlay needs that same "gray behind mint" story. If we just
  // iterated the hovered subtree in slice order, the first color to
  // show up would be the anchor's color — whatever it happens to be —
  // which flips the stack and lets tiny gray density buckets bleed
  // through the middle of a wide mint parent bucket (the reported
  // `performWorkUntilDeadline` bug).
  //
  // So we do a two-pass walk over the *same* visible-slice window the
  // base sees. Pass 1 establishes the batch map and its insertion
  // order using every visible slice (so the color order matches the
  // base exactly). Pass 2 — actually, folded into the same loop — only
  // pushes a rect when the slice also passes the containment filter.
  // Empty batches are a no-op at emit time, so there's no wasted
  // fillRect; only the first-seen-per-color key insertion costs
  // anything for filtered-out slices.
  const batches = getScratchBatches()

  for (let i = first; i < count; i++) {
    const s = starts[i]
    if (s > visibleEndMs) break
    const e = ends[i]
    if (e < visibleStartMs) continue
    const d = depths[i]
    if (d >= maxDepthExclusive) continue

    const color = colors[i] >>> 0
    // Ensure the batch key is inserted the first time we see this
    // color in the *visible* window — this is what makes the overlay's
    // emit order match the base's. Done BEFORE the containment check.
    let batch = batches.get(color)
    if (!batch) {
      batch = {x: [], y: [], w: [], h: [], color}
      batches.set(color, batch)
    }

    if (s < hiStart || e > hiEnd || d < hiMinDepth) continue

    const xCss = (s - canvasStartMs) * pxPerMs
    const wCssRaw = (e - s) * pxPerMs
    const bucketCount = counts ? counts[i] : 1
    if (bucketCount === 1 && wCssRaw < 1) continue
    const wCss = wCssRaw < 1.5 ? 1 : wCssRaw
    const y = d * rowHeight + ROW_VPAD_PX / 2
    batch.x.push(xCss)
    batch.y.push(y)
    batch.w.push(wCss)
    batch.h.push(rowH)

    if (flags[i] & SLICE_FLAG_COMPACTED) {
      stripeScratch.push({x: xCss, y, w: wCss, h: rowH})
    }

    if (
      labelScratch &&
      bucketCount === 1 &&
      wCss >= LABEL_MIN_WIDTH_PX &&
      baseMeasures
    ) {
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
    if (batch.x.length === 0) continue
    ctx.fillStyle = unpackColorToCss(batch.color)
    const len = batch.x.length
    for (let k = 0; k < len; k++) {
      ctx.fillRect(batch.x[k], batch.y[k], batch.w[k], batch.h[k])
    }
  }

  paintStripeOverlay(ctx, stripeScratch)

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

interface Batch {
  x: number[]
  y: number[]
  w: number[]
  h: number[]
  /** Packed `0xRRGGBBAA` of the batch — one batch per distinct color. */
  color: number
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

interface StripeRect {
  x: number
  y: number
  w: number
  h: number
}

const STRIPE_SCRATCH: StripeRect[] = []
function getScratchStripes(): StripeRect[] {
  STRIPE_SCRATCH.length = 0
  return STRIPE_SCRATCH
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
  cropText,
  measureCache,
  cropCache,
  ensureStripePattern,
  STRIPE_PATTERN_CACHE,
  STRIPE_FALLBACK_FILL,
}
