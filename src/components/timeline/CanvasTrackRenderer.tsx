import {memo, useEffect, useRef} from 'react'
import type {Track as TrackModel} from '../../core'
import {
  EMPTY_MARK_BUFFERS,
  EMPTY_SLICE_BUFFERS,
} from '../../core/render/sliceBuffers'
import {drawFrame} from './canvas2d'
import type {ViewportStore} from './viewportStore'
import {ROW_HEIGHT} from './trackLayout'

interface CanvasTrackRendererProps {
  track: TrackModel
  heightPx: number
  labelWidthPx: number
  store: ViewportStore
  onToggle?: () => void
  expanded: boolean
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
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Cache the last applied CSS size so we skip the backing-store resize
    // (and the `setTransform(dpr, ...)` that goes with it) when neither the
    // viewport width nor DPR has changed.
    let lastWidthCss = -1
    let lastHeightCss = -1
    let lastDpr = -1

    const render = (): void => {
      rafRef.current = null
      const state = store.get()
      const pxPerMs = state.pxPerMs
      if (pxPerMs <= 0) {
        // Nothing to draw yet — parse might still be in progress.
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        return
      }
      const widthCss = Math.max(
        0,
        state.viewportWidth - state.labelWidthPx,
      )
      const heightCss = heightPx
      const dpr = window.devicePixelRatio || 1

      if (widthCss !== lastWidthCss || heightCss !== lastHeightCss || dpr !== lastDpr) {
        canvas.style.width = `${widthCss}px`
        canvas.style.height = `${heightCss}px`
        canvas.width = Math.max(1, Math.round(widthCss * dpr))
        canvas.height = Math.max(1, Math.round(heightCss * dpr))
        // setTransform so draw commands use CSS pixels.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lastWidthCss = widthCss
        lastHeightCss = heightCss
        lastDpr = dpr
      }

      if (widthCss <= 0) return

      // The content layer starts at labelWidthPx in the outer scroller; the
      // canvas itself starts at x=0 of that layer. So the ms at the canvas's
      // left edge = timelineStart + scrollLeft / pxPerMs. Then we overdraw
      // by half the viewport on each side so small horizontal scroll
      // jitters don't clip content at the edges.
      const msAtCanvasLeft = state.timelineStart + state.scrollLeft / pxPerMs
      const visibleDurationMs = widthCss / pxPerMs
      const visibleStartMs = msAtCanvasLeft
      const visibleEndMs = msAtCanvasLeft + visibleDurationMs

      drawFrame({
        ctx,
        buffers: track.buffers ?? EMPTY_SLICE_BUFFERS,
        marks: track.markBuffers ?? EMPTY_MARK_BUFFERS,
        widthCss,
        heightCss,
        rowHeight: ROW_HEIGHT,
        pxPerMs,
        visibleStartMs,
        visibleEndMs,
        canvasStartMs: msAtCanvasLeft,
        // When collapsed, only draw direct children of the track root
        // (depth 0). Matches the behavior of the old DOM renderer's
        // `maxDepth = expanded ? ∞ : 1` rule.
        maxDepthExclusive: expanded ? Number.POSITIVE_INFINITY : 1,
      })
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
        Canvas sits as the second flex item and uses `position: sticky;
        left: labelWidthPx` so it stays pinned just right of the label as
        the scroller pans. We can't use `position: absolute` here — that
        would make the canvas scroll with the content (its containing
        block is the row, which is inside the huge innerWidthPx surface),
        so it would march off-screen as the user scrolls right. Sticky
        keeps it viewport-pinned while still letting the outer scroller
        handle pan natively.

        Width and backing-store size are applied imperatively in the
        useEffect above so we don't trigger a React re-render per frame.
      */}
      <canvas
        ref={canvasRef}
        data-testid="track-canvas"
        className="pointer-events-none"
        style={{
          position: 'sticky',
          left: labelWidthPx,
          top: 0,
          flexShrink: 0,
          height: heightPx,
          display: 'block',
        }}
      />
    </div>
  )
}

export default memo(CanvasTrackRendererBase)
