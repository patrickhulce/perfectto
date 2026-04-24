import {memo, useEffect, useRef} from 'react'
import type {Track as TrackModel} from '../../core'
import {
  EMPTY_MARK_BUFFERS,
  EMPTY_SLICE_BUFFERS,
  pickMipmapLevel,
} from '../../core/render/sliceBuffers'
import {drawFrame, drawHighlightFrame} from './canvas2d'
import type {ViewportStore} from './viewportStore'
import type {SelectionStore} from './selectionStore'
import {ROW_HEIGHT} from './trackLayout'
import {isSkirtEnabled} from './skirtFlag'
import {computeAxisTicks} from './timeAxis'

interface CanvasTrackRendererProps {
  track: TrackModel
  heightPx: number
  labelWidthPx: number
  store: ViewportStore
  /**
   * Selection store consulted each frame to compute the tree-highlight
   * region for this track. Hovered slice takes precedence over selected
   * slice; both are scoped by `trackId` so a hover/click on one track
   * doesn't cause every other track to repaint.
   */
  selectionStore: SelectionStore
  onToggle?: () => void
  expanded: boolean
}

/**
 * Phase 3 buffered-bounds factor. The canvas is drawn `SKIRT_FACTOR ×
 * viewport-content-width` pixels wide so most horizontal scrolls are
 * compositor-only `transform: translateX(...)` updates instead of full
 * redraws.
 *
 * `3` = one viewport on the left, one in the middle, one on the right —
 * matches the Perfetto `BufferedBounds` 3× total skirt the mission doc
 * cites.
 */
const SKIRT_FACTOR = 3

/**
 * When the visible viewport's left or right edge gets within this many CSS
 * pixels of the drawn canvas's edge we redraw + recenter. Half a viewport
 * means the user has at least one full viewport of buffered pan in either
 * direction at any time — equivalent to Perfetto's "redraw at threshold
 * cross" behavior.
 */
const SKIRT_EDGE_THRESHOLD_FRACTION = 0.5

/**
 * Duration of the overlay's opacity fade-out when a hover/selection ends.
 * Kept in lockstep with the base canvas's `transition: opacity` below so
 * the flame-chart's "de-emphasis" and the highlight's "fade away" finish
 * at the same time — hovering off a slice feels like one motion instead
 * of two competing ones.
 */
const OVERLAY_FADE_OUT_MS = 500

/**
 * Snapshot of what the base canvas currently has painted on it. Updated
 * every time we redraw the base; consulted every frame to decide between
 * a cheap `translateX` update and a full repaint. The base canvas's
 * painted pixels are selection-agnostic — selection/hover only adjust
 * CSS opacity and the sibling overlay canvas (see {@link OverlayPaint}),
 * so selection changes never invalidate this snapshot.
 */
interface LoadedRange {
  /** `pxPerMs` the canvas was painted at. Any change forces a full redraw. */
  pxPerMs: number
  /**
   * `scrollLeft` value at which the canvas's leftmost pixel sits. Used to
   * compute the per-frame translate as `loadedScrollLeft - state.scrollLeft`.
   */
  scrollLeftAnchor: number
  /** Width in CSS px of the painted canvas (always `SKIRT_FACTOR × content`). */
  widthCss: number
  /** Height in CSS px the canvas was painted at; redraw if track height changes. */
  heightCss: number
  /** `expanded` value at paint time; redraw if it flips so depth-1 lines (re)appear. */
  expanded: boolean
  /** Track identity at paint time; redraw on track swap (rare, but cheap to guard). */
  trackId: string
}

/**
 * Snapshot of what the overlay canvas currently has painted. Null when
 * the overlay is empty (no highlight). We repaint the overlay whenever
 * either the base anchor moves (so the drawn highlight keeps tracking
 * its logical ms positions across skirt pans) or the highlight span
 * itself changes, and we clear the canvas when the highlight goes away.
 */
interface OverlayPaint {
  pxPerMs: number
  scrollLeftAnchor: number
  widthCss: number
  heightCss: number
  expanded: boolean
  trackId: string
  /** Stable string key for the currently painted highlight. */
  highlightKey: string
}

/**
 * Per-track canvas. Owns a single `<canvas>` sized to the track's content
 * area (everything right of the sticky label), subscribes to the shared
 * `ViewportStore`, and repaints on RAF whenever pxPerMs / scrollLeft /
 * viewport width changes.
 *
 * The component re-renders from React only when expansion state or track
 * height changes — scroll/zoom never round-trip through the React tree.
 */
function CanvasTrackRendererBase({
  track,
  heightPx,
  labelWidthPx,
  store,
  selectionStore,
  onToggle,
  expanded,
}: CanvasTrackRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const overlay = overlayRef.current
    const wrapper = wrapperRef.current
    if (!canvas || !overlay || !wrapper) return
    const ctx = canvas.getContext('2d')
    const overlayCtx = overlay.getContext('2d')
    if (!ctx || !overlayCtx) return

    const skirtEnabled = isSkirtEnabled()
    let lastWrapperWidthCss = -1

    // Cache the last applied backing size so we skip the (somewhat
    // expensive) resize + `setTransform(dpr, ...)` work when nothing has
    // changed about geometry. Tracks both canvases' actual pixel buffer
    // dimensions — they stay in lockstep so CSS-pixel draw coords align.
    let lastBackingWidthCss = -1
    let lastBackingHeightCss = -1
    let lastDpr = -1
    let lastBaseOpacity = ''
    let lastOverlayOpacity = ''
    let loaded: LoadedRange | null = null
    let overlayPainted: OverlayPaint | null = null
    // Remembered so we can keep the highlight rect on the overlay canvas
    // during the fade-out — without it, `currentHighlight()` returns
    // `undefined` the instant the user moves off and we'd wipe the
    // pixels before CSS had anything to fade.
    let lastHighlight: {startMs: number; endMs: number; minDepth: number} | undefined = undefined
    let overlayClearTimer: number | null = null

    /**
     * Resolve which (if any) slice on *this* track should drive the
     * overlay's highlight draw. Hover wins over click-selection — if
     * both exist at once the cursor is over the hover target, so it's
     * the more immediate intent. Returns `undefined` when no slice on
     * this track is active, which empties the overlay.
     */
    const currentHighlight = (): {startMs: number; endMs: number; minDepth: number} | undefined => {
      const sel = selectionStore.get()
      const hl = sel.hoveredSlice ?? sel.selectedSlice
      if (!hl || hl.trackId !== track.id) return undefined
      return {startMs: hl.startMs, endMs: hl.endMs, minDepth: hl.depth}
    }

    const highlightKeyOf = (
      hl: {startMs: number; endMs: number; minDepth: number} | undefined,
    ): string => (hl === undefined ? '' : `${hl.startMs}|${hl.endMs}|${hl.minDepth}`)

    const syncBaseOpacity = (): void => {
      const sel = selectionStore.get()
      const nextOpacity = (sel.hoveredSlice ?? sel.selectedSlice) ? '0.4' : '0.8'
      if (nextOpacity === lastBaseOpacity) return
      canvas.style.opacity = nextOpacity
      lastBaseOpacity = nextOpacity
    }

    const syncOverlayOpacity = (hasHighlight: boolean): void => {
      const next = hasHighlight ? '1' : '0'
      if (next === lastOverlayOpacity) return
      overlay.style.opacity = next
      lastOverlayOpacity = next
    }

    /**
     * Wipe the overlay canvas for real. Called at the end of the fade-out
     * window (or immediately on unmount / view-invalidating changes) so
     * stale highlight pixels don't linger behind an invisible canvas and
     * pop back in if something re-enables opacity.
     */
    const clearOverlayNow = (): void => {
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
      overlayPainted = null
      lastHighlight = undefined
    }

    const cancelPendingOverlayClear = (): void => {
      if (overlayClearTimer === null) return
      window.clearTimeout(overlayClearTimer)
      overlayClearTimer = null
    }

    /**
     * Keep both canvases' backing stores identical. The overlay sits
     * directly over the base and uses the same CSS-pixel coordinate
     * space, so they must share width, height, and the DPR transform.
     */
    const resizeBackingStores = (canvasWidthCss: number, heightCss: number): void => {
      const dpr = window.devicePixelRatio || 1
      if (
        canvasWidthCss === lastBackingWidthCss &&
        heightCss === lastBackingHeightCss &&
        dpr === lastDpr
      ) {
        return
      }
      for (const c of [canvas, overlay]) {
        c.style.width = `${canvasWidthCss}px`
        c.style.height = `${heightCss}px`
        c.width = Math.max(1, Math.round(canvasWidthCss * dpr))
        c.height = Math.max(1, Math.round(heightCss * dpr))
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      lastBackingWidthCss = canvasWidthCss
      lastBackingHeightCss = heightCss
      lastDpr = dpr
    }

    const fullRedrawBase = (
      contentWidthCss: number,
      heightCss: number,
      pxPerMs: number,
      scrollLeftAnchor: number,
    ): void => {
      // The skirt buys us 3 viewport-widths of cached pan; outside skirt
      // mode we draw exactly one viewport wide, exactly aligned with the
      // visible window.
      const canvasWidthCss = skirtEnabled ? contentWidthCss * SKIRT_FACTOR : contentWidthCss
      resizeBackingStores(canvasWidthCss, heightCss)

      const state = store.get()
      const msAtCanvasLeft = state.timelineStart + scrollLeftAnchor / pxPerMs
      const visibleDurationMs = canvasWidthCss / pxPerMs
      const visibleStartMs = msAtCanvasLeft
      const visibleEndMs = msAtCanvasLeft + visibleDurationMs

      const slices = track.mipmap
        ? pickMipmapLevel(track.mipmap, pxPerMs)
        : (track.buffers ?? EMPTY_SLICE_BUFFERS)
      const baseMeasures = track.mipmap ? track.mipmap.base.measures : track.buffers?.measures

      // Compute tick positions from the same store snapshot the top
      // `TimelineAxis` uses. Pure function, sub-millisecond per frame
      // even for week-long traces, and sharing it guarantees the
      // gridlines line up pixel-perfect with the axis labels.
      const ticks = computeAxisTicks({
        timelineStart: state.timelineStart,
        timelineEnd: state.timelineEnd,
        pxPerMs,
        rangeStartMs: visibleStartMs,
        rangeEndMs: visibleEndMs,
      })

      drawFrame({
        ctx,
        slices,
        // Marks intentionally suppressed for now — the 2px orange ticks drown
        // the measures visually on dense traces. Re-enable once we have a
        // density/zoom gate that keeps them legible without overwhelming.
        marks: EMPTY_MARK_BUFFERS,
        widthCss: canvasWidthCss,
        heightCss,
        rowHeight: ROW_HEIGHT,
        pxPerMs,
        visibleStartMs,
        visibleEndMs,
        canvasStartMs: msAtCanvasLeft,
        maxDepthExclusive: expanded ? Number.POSITIVE_INFINITY : 1,
        baseMeasures,
        majorGridTicksMs: ticks.majorTicksMs,
        minorGridTicksMs: ticks.minorTicksMs,
      })

      loaded = {
        pxPerMs,
        scrollLeftAnchor,
        widthCss: canvasWidthCss,
        heightCss,
        expanded,
        trackId: track.id,
      }
      // Moving the base anchor invalidates any previously painted
      // overlay (its drawn coords were anchored to the old scrollLeft).
      // Clearing forces the overlay repaint below.
      overlayPainted = null
    }

    const redrawOverlay = (
      pxPerMs: number,
      scrollLeftAnchor: number,
      canvasWidthCss: number,
      heightCss: number,
      highlight: ReturnType<typeof currentHighlight>,
    ): void => {
      if (!highlight) {
        overlayCtx.clearRect(0, 0, canvasWidthCss, heightCss)
        overlayPainted = null
        return
      }
      const state = store.get()
      const msAtCanvasLeft = state.timelineStart + scrollLeftAnchor / pxPerMs
      const visibleDurationMs = canvasWidthCss / pxPerMs
      const slices = track.mipmap
        ? pickMipmapLevel(track.mipmap, pxPerMs)
        : (track.buffers ?? EMPTY_SLICE_BUFFERS)
      const baseMeasures = track.mipmap ? track.mipmap.base.measures : track.buffers?.measures

      drawHighlightFrame({
        ctx: overlayCtx,
        slices,
        widthCss: canvasWidthCss,
        heightCss,
        rowHeight: ROW_HEIGHT,
        pxPerMs,
        visibleStartMs: msAtCanvasLeft,
        visibleEndMs: msAtCanvasLeft + visibleDurationMs,
        canvasStartMs: msAtCanvasLeft,
        maxDepthExclusive: expanded ? Number.POSITIVE_INFINITY : 1,
        baseMeasures,
        highlight,
      })

      overlayPainted = {
        pxPerMs,
        scrollLeftAnchor,
        widthCss: canvasWidthCss,
        heightCss,
        expanded,
        trackId: track.id,
        highlightKey: highlightKeyOf(highlight),
      }
    }

    const render = (): void => {
      rafRef.current = null
      syncBaseOpacity()
      const state = store.get()
      const pxPerMs = state.pxPerMs
      if (pxPerMs <= 0) {
        // Parse not finished yet; clear both canvases and bail.
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        cancelPendingOverlayClear()
        clearOverlayNow()
        loaded = null
        return
      }
      const contentWidthCss = Math.max(0, state.viewportWidth - state.labelWidthPx)
      if (contentWidthCss <= 0) return

      // Keep the sticky wrapper width in lockstep with the viewport's
      // content area. Mutating `style.width` on the wrapper is a layout-only
      // op and only fires on actual resize (we cache and skip).
      if (contentWidthCss !== lastWrapperWidthCss) {
        wrapper.style.width = `${contentWidthCss}px`
        lastWrapperWidthCss = contentWidthCss
      }

      const heightCss = heightPx
      const edgeThresholdPx = contentWidthCss * SKIRT_EDGE_THRESHOLD_FRACTION

      // Base-canvas invalidation. Selection state deliberately does not
      // appear here — selection/hover only affect CSS opacity plus the
      // sibling overlay, never the base pixels.
      const baseMustRedraw =
        !skirtEnabled ||
        loaded === null ||
        loaded.pxPerMs !== pxPerMs ||
        loaded.heightCss !== heightCss ||
        loaded.expanded !== expanded ||
        loaded.trackId !== track.id ||
        state.scrollLeft - loaded.scrollLeftAnchor < edgeThresholdPx ||
        loaded.scrollLeftAnchor + loaded.widthCss - (state.scrollLeft + contentWidthCss) <
          edgeThresholdPx

      if (baseMustRedraw) {
        // Recenter so we have one viewport of skirt on each side. Outside
        // skirt mode anchor === scrollLeft (no overdraw, no transform).
        const anchor = skirtEnabled ? state.scrollLeft - contentWidthCss : state.scrollLeft
        fullRedrawBase(contentWidthCss, heightCss, pxPerMs, anchor)
      }

      if (!loaded) return

      // Both canvases always share the same transform so overlay content
      // stays pinned to the same logical ms positions as the base rects
      // underneath it. One write per frame, no layout.
      const translate = `translateX(${loaded.scrollLeftAnchor - state.scrollLeft}px)`
      canvas.style.transform = translate
      overlay.style.transform = translate

      // Overlay repaint decisions are orthogonal to the base's skirt
      // logic: we repaint whenever the selection changes, whenever the
      // base's anchor moves (which happens on zoom / skirt recenter),
      // or when expansion / track identity flips. Content-drift-only
      // scrolls (base translate, no redraw) leave the overlay
      // untouched — its drawn rects are already anchored correctly.
      const highlight = currentHighlight()
      // When the hover goes away we keep the last-drawn highlight on the
      // canvas and let CSS fade opacity to 0 over OVERLAY_FADE_OUT_MS. A
      // trailing timer clears the pixels once the transition has
      // finished; if a new highlight arrives first the timer is cancelled
      // and we paint the new one immediately at opacity 1.
      if (highlight) {
        cancelPendingOverlayClear()
        lastHighlight = highlight
      } else if (lastHighlight !== undefined && overlayClearTimer === null) {
        overlayClearTimer = window.setTimeout(() => {
          overlayClearTimer = null
          clearOverlayNow()
          schedule()
        }, OVERLAY_FADE_OUT_MS)
      }
      syncOverlayOpacity(!!highlight)

      const drawHighlight = highlight ?? (overlayClearTimer !== null ? lastHighlight : undefined)
      const highlightKey = highlightKeyOf(drawHighlight)
      const overlayMustRedraw =
        overlayPainted === null ||
        overlayPainted.pxPerMs !== loaded.pxPerMs ||
        overlayPainted.scrollLeftAnchor !== loaded.scrollLeftAnchor ||
        overlayPainted.widthCss !== loaded.widthCss ||
        overlayPainted.heightCss !== loaded.heightCss ||
        overlayPainted.expanded !== expanded ||
        overlayPainted.trackId !== track.id ||
        overlayPainted.highlightKey !== highlightKey
      if (overlayMustRedraw) {
        redrawOverlay(
          loaded.pxPerMs,
          loaded.scrollLeftAnchor,
          loaded.widthCss,
          loaded.heightCss,
          drawHighlight,
        )
      }
    }

    const schedule = (): void => {
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(render)
    }

    // Draw once immediately so the first paint isn't blank.
    schedule()

    const unsubscribe = store.subscribe(() => {
      schedule()
    })
    // Selection-store subscriptions are coalesced into the same RAF as
    // viewport updates via `schedule()`, so rapid hover writes collapse
    // to one repaint per frame — never one per pointermove.
    const unsubscribeSelection = selectionStore.subscribe(() => {
      schedule()
    })

    const dprMedia =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        : null
    const onDprChange = (): void => schedule()
    dprMedia?.addEventListener?.('change', onDprChange)

    return () => {
      unsubscribe()
      unsubscribeSelection()
      dprMedia?.removeEventListener?.('change', onDprChange)
      cancelPendingOverlayClear()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [track, store, selectionStore, heightPx, expanded])

  const canToggle = !!onToggle
  // Screen-reader summary for the gutter button. The canvas is non-
  // interactive (`pointer-events: none`), so the gutter button is the only
  // focusable affordance per row — its aria-label is the entire a11y story
  // for the row's contents.
  const measureCount = track.buffers?.count ?? 0
  const ariaLabel =
    `${track.name}` +
    (track.category ? ` (${track.category})` : '') +
    `, ${measureCount} measure${measureCount === 1 ? '' : 's'}` +
    (canToggle ? `, ${expanded ? 'expanded' : 'collapsed'}` : '')

  return (
    <div
      className="border-b border-[#1a202c] bg-[#11151d]"
      style={{
        // Flex is what makes the two sticky children sit side-by-side:
        // without it they'd stack as block elements and the canvas would
        // wrap onto a second line below the label, rendering off-screen.
        display: 'flex',
        alignItems: 'stretch',
        height: heightPx,
        width: '100%',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!canToggle}
        aria-label={ariaLabel}
        aria-expanded={canToggle ? expanded : undefined}
        data-no-pan
        className={
          'flex items-start gap-2 border-r border-[#2d3748] bg-[#11151d] px-4 py-2 text-left text-xs text-[#a0aec0]' +
          (canToggle ? ' cursor-pointer hover:bg-[#151b25]' : ' cursor-default')
        }
        style={{
          position: 'sticky',
          left: 0,
          top: 0,
          // Above SelectionOverlay (z=1) so the yellow selection tint
          // slides *behind* the label gutter when the user scrolls
          // right, matching how the flame-chart canvas naturally tucks
          // behind the sticky label column.
          zIndex: 3,
          flexShrink: 0,
          width: labelWidthPx,
          height: heightPx,
        }}
      >
        <span aria-hidden className="mt-px inline-block w-3 shrink-0 text-[#718096]">
          {canToggle ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-[#cbd5e0]">{track.name}</span>
          {track.category && (
            <span className="block truncate text-[10px] uppercase tracking-wide text-[#718096]">
              {track.category}
            </span>
          )}
        </span>
      </button>
      {/*
        Skirt wrapper. Sticky-pinned to `left: labelWidthPx` so it always
        hugs the gutter as the outer surface scrolls; `overflow: hidden`
        clips the wider-than-viewport canvas inside it. The canvas itself
        is a 3× viewport wide buffer (Phase 3) translated horizontally to
        align with the current scroll position. Width is set to the live
        viewport content width via CSS calc — no React re-render per
        viewport-resize tick because the calc resolves at layout time.
      */}
      <div
        ref={wrapperRef}
        data-testid="track-canvas-skirt"
        className="pointer-events-none overflow-hidden"
        style={{
          position: 'sticky',
          left: labelWidthPx,
          top: 0,
          flexShrink: 0,
          height: heightPx,
          // Width is set imperatively in the render loop from the live
          // viewport-content size (viewportWidth - labelWidthPx). Starts at
          // 0 so the first paint never flashes a too-wide canvas.
          width: 0,
          display: 'block',
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="track-canvas"
          className="pointer-events-none"
          style={{
            // The canvas's CSS width is set imperatively in the useEffect
            // above (it's a multiple of the viewport content width). We
            // anchor it at left:0 of the wrapper and slide via transform.
            position: 'absolute',
            left: 0,
            top: 0,
            height: heightPx,
            display: 'block',
            // willChange hints the compositor to keep this on its own
            // layer so translateX during pan never paints.
            willChange: 'transform, opacity',
            // Ease opacity changes a bit so hover/selection emphasis feels
            // deliberate instead of flashing on quick pointer movement.
            transition: 'opacity 500ms ease-out',
            // The RAF render loop owns this opacity so it can switch
            // between the idle (0.8) and active-highlight (0.4) states
            // without a React re-render. The full-opacity overlay canvas
            // stacked on top keeps the highlighted subtree at 1.0.
            opacity: 0.8,
          }}
        />
        <canvas
          ref={overlayRef}
          data-testid="track-canvas-overlay"
          className="pointer-events-none"
          style={{
            // Stacks directly over the base canvas. Shares the same
            // CSS-pixel coordinate space and transform (applied each
            // frame from the useEffect above), so rects painted here
            // register against the underlying base rects pixel-for-
            // pixel. Cleared + redrawn on every hover/selection
            // change; untouched during skirt-translate pans.
            position: 'absolute',
            left: 0,
            top: 0,
            height: heightPx,
            display: 'block',
            willChange: 'transform, opacity',
            // Match the base's fade so both canvases settle together
            // when the user moves off a slice. The RAF loop flips
            // opacity between 0 and 1; the pixels are left on the
            // canvas until the trailing clear timer fires so there's
            // something here to actually transition.
            transition: 'opacity 500ms ease-out',
            opacity: 0,
          }}
        />
      </div>
    </div>
  )
}

export default memo(CanvasTrackRendererBase)
