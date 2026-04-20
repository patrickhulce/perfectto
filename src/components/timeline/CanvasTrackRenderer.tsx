import {memo, useEffect, useRef} from 'react'
import type {Track as TrackModel} from '../../core'
import {
  EMPTY_MARK_BUFFERS,
  EMPTY_SLICE_BUFFERS,
  pickMipmapLevel,
} from '../../core/render/sliceBuffers'
import {drawFrame} from './canvas2d'
import type {ViewportStore} from './viewportStore'
import {ROW_HEIGHT} from './trackLayout'
import {isSkirtEnabled} from './skirtFlag'

interface CanvasTrackRendererProps {
  track: TrackModel
  heightPx: number
  labelWidthPx: number
  store: ViewportStore
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
 * Snapshot of what the canvas currently has painted on it. Updated every
 * time we redraw; consulted every frame to decide between a cheap
 * `translateX` update and a full repaint.
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
  onToggle,
  expanded,
}: CanvasTrackRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrapper = wrapperRef.current
    if (!canvas || !wrapper) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const skirtEnabled = isSkirtEnabled()
    let lastWrapperWidthCss = -1

    // Cache the last applied backing size so we skip the (somewhat
    // expensive) resize + `setTransform(dpr, ...)` work when nothing has
    // changed about geometry. Tracks the canvas's actual pixel buffer
    // dimensions, not the wrapper's.
    let lastBackingWidthCss = -1
    let lastBackingHeightCss = -1
    let lastDpr = -1
    /**
     * What the canvas currently has painted. `null` means "must redraw" —
     * either we haven't drawn yet, or geometry changed in a way the
     * translate-only path can't handle.
     */
    let loaded: LoadedRange | null = null

    const fullRedraw = (
      contentWidthCss: number,
      heightCss: number,
      pxPerMs: number,
      scrollLeftAnchor: number,
    ): void => {
      // The skirt buys us 3 viewport-widths of cached pan; outside skirt
      // mode we draw exactly one viewport wide, exactly aligned with the
      // visible window.
      const canvasWidthCss = skirtEnabled
        ? contentWidthCss * SKIRT_FACTOR
        : contentWidthCss
      const dpr = window.devicePixelRatio || 1

      if (
        canvasWidthCss !== lastBackingWidthCss ||
        heightCss !== lastBackingHeightCss ||
        dpr !== lastDpr
      ) {
        canvas.style.width = `${canvasWidthCss}px`
        canvas.style.height = `${heightCss}px`
        canvas.width = Math.max(1, Math.round(canvasWidthCss * dpr))
        canvas.height = Math.max(1, Math.round(heightCss * dpr))
        // setTransform so draw commands use CSS pixels regardless of dpr.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lastBackingWidthCss = canvasWidthCss
        lastBackingHeightCss = heightCss
        lastDpr = dpr
      }

      const state = store.get()
      const msAtCanvasLeft =
        state.timelineStart + scrollLeftAnchor / pxPerMs
      const visibleDurationMs = canvasWidthCss / pxPerMs
      const visibleStartMs = msAtCanvasLeft
      const visibleEndMs = msAtCanvasLeft + visibleDurationMs

      const slices = track.mipmap
        ? pickMipmapLevel(track.mipmap, pxPerMs)
        : track.buffers ?? EMPTY_SLICE_BUFFERS
      const baseMeasures = track.mipmap
        ? track.mipmap.base.measures
        : track.buffers?.measures

      drawFrame({
        ctx,
        slices,
        marks: track.markBuffers ?? EMPTY_MARK_BUFFERS,
        widthCss: canvasWidthCss,
        heightCss,
        rowHeight: ROW_HEIGHT,
        pxPerMs,
        visibleStartMs,
        visibleEndMs,
        canvasStartMs: msAtCanvasLeft,
        maxDepthExclusive: expanded ? Number.POSITIVE_INFINITY : 1,
        baseMeasures,
      })

      loaded = {
        pxPerMs,
        scrollLeftAnchor,
        widthCss: canvasWidthCss,
        heightCss,
        expanded,
        trackId: track.id,
      }
      // Apply the matching translate so the drawn region aligns with the
      // current scroll position. Outside skirt mode this is always 0
      // (anchor = scrollLeft).
      canvas.style.transform = `translateX(${
        scrollLeftAnchor - state.scrollLeft
      }px)`
    }

    const render = (): void => {
      rafRef.current = null
      const state = store.get()
      const pxPerMs = state.pxPerMs
      if (pxPerMs <= 0) {
        // Parse not finished yet; clear and bail.
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        loaded = null
        return
      }
      const contentWidthCss = Math.max(
        0,
        state.viewportWidth - state.labelWidthPx,
      )
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

      // Decide between cheap translate and full redraw.
      const mustRedraw =
        !skirtEnabled ||
        loaded === null ||
        loaded.pxPerMs !== pxPerMs ||
        loaded.heightCss !== heightCss ||
        loaded.expanded !== expanded ||
        loaded.trackId !== track.id ||
        // Approaching the left edge of the painted canvas.
        state.scrollLeft - loaded.scrollLeftAnchor < edgeThresholdPx ||
        // Approaching the right edge of the painted canvas.
        loaded.scrollLeftAnchor + loaded.widthCss -
          (state.scrollLeft + contentWidthCss) <
          edgeThresholdPx

      if (mustRedraw) {
        // Recenter so we have one viewport of skirt on each side. Outside
        // skirt mode anchor === scrollLeft (no overdraw, no transform).
        const anchor = skirtEnabled
          ? state.scrollLeft - contentWidthCss
          : state.scrollLeft
        fullRedraw(contentWidthCss, heightCss, pxPerMs, anchor)
      } else if (loaded) {
        // Cheap path: just slide the already-painted canvas. No fillRect
        // calls, no clearRect, no React work — this is the whole point of
        // the skirt.
        canvas.style.transform = `translateX(${
          loaded.scrollLeftAnchor - state.scrollLeft
        }px)`
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

    const dprMedia =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        : null
    const onDprChange = (): void => schedule()
    dprMedia?.addEventListener?.('change', onDprChange)

    return () => {
      unsubscribe()
      dprMedia?.removeEventListener?.('change', onDprChange)
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [track, store, heightPx, expanded])

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
          'flex items-start gap-1 border-r border-[#2d3748] bg-[#11151d] px-2 py-2 text-left text-xs text-[#a0aec0]' +
          (canToggle ? ' cursor-pointer hover:bg-[#151b25]' : ' cursor-default')
        }
        style={{
          position: 'sticky',
          left: 0,
          top: 0,
          zIndex: 1,
          flexShrink: 0,
          width: labelWidthPx,
          height: heightPx,
        }}
      >
        <span
          aria-hidden
          className="mt-px inline-block w-3 shrink-0 text-[#718096]"
        >
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
            willChange: 'transform',
          }}
        />
      </div>
    </div>
  )
}

export default memo(CanvasTrackRendererBase)
