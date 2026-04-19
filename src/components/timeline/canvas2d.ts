import {
  lowerBoundF32,
  type MarkBuffers,
  type SliceBuffers,
} from '../../core/render/sliceBuffers'
import {unpackColorToCss} from '../../core/render/packColor'

export interface DrawFrameArgs {
  ctx: CanvasRenderingContext2D
  buffers: SliceBuffers
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
 * Batched fillRect renderer. Groups slices by packed color so we only assign
 * `ctx.fillStyle` once per color, which is the dominant cost for large
 * traces (setting fillStyle re-parses the color every time).
 *
 * Complexity per frame: O(visible_slices), with visible_slices bounded by
 * (viewport_px) in practice once slices narrower than 1px are dropped.
 */
export function drawFrame(args: DrawFrameArgs): void {
  const {
    ctx,
    buffers,
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
  if (buffers.count > 0) {
    // Binary-search the running-max-of-ends prefix to find the earliest
    // index whose slice could still reach into the viewport. Everything
    // before that is guaranteed to end before visibleStartMs and can be
    // skipped entirely. This correctly preserves long-spanning ancestor
    // slices (e.g. a depth-0 parent covering the whole track) even when
    // hundreds of their shorter descendants sit between them and the
    // viewport in the sorted `starts` array.
    const first = lowerBoundF32(
      buffers.maxEndsPrefix,
      buffers.count,
      visibleStartMs,
    )

    // Group by color. Most traces have <20 distinct colors total, so this
    // Map never grows; we reuse the batch arrays across calls.
    const batches = getScratchBatches()

    const rowH = rowHeight - ROW_VPAD_PX
    const starts = buffers.starts
    const ends = buffers.ends
    const depths = buffers.depths
    const colors = buffers.colors
    const count = buffers.count

    for (let i = first; i < count; i++) {
      const s = starts[i]
      if (s > visibleEndMs) break
      const e = ends[i]
      if (e < visibleStartMs) continue
      const d = depths[i]
      if (d >= maxDepthExclusive) continue
      const xCss = (s - canvasStartMs) * pxPerMs
      const wCssRaw = (e - s) * pxPerMs
      if (wCssRaw < 1) continue // sub-pixel cull
      // Tiny rects render as at least 1px so single ticks don't disappear.
      const wCss = wCssRaw < 1.5 ? 1 : wCssRaw
      const y = d * rowHeight + ROW_VPAD_PX / 2
      const color = colors[i]
      let batch = batches.get(color)
      if (!batch) {
        batch = {x: [], y: [], w: [], h: []}
        batches.set(color, batch)
      }
      batch.x.push(xCss)
      batch.y.push(y)
      batch.w.push(wCss)
      batch.h.push(rowH)
    }

    for (const [color, batch] of batches) {
      ctx.fillStyle = unpackColorToCss(color)
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
      let batch = batches.get(color)
      if (!batch) {
        batch = {x: [], y: [], w: [], h: []}
        batches.set(color, batch)
      }
      batch.x.push(xCss)
      batch.y.push(y)
      batch.w.push(2)
      batch.h.push(h)
    }

    for (const [color, batch] of batches) {
      ctx.fillStyle = unpackColorToCss(color)
      const len = batch.x.length
      for (let k = 0; k < len; k++) {
        ctx.fillRect(batch.x[k], batch.y[k], batch.w[k], batch.h[k])
      }
    }
  }
}

interface Batch {
  x: number[]
  y: number[]
  w: number[]
  h: number[]
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
