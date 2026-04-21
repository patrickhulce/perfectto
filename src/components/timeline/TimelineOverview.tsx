import {memo, useEffect, useRef, type MutableRefObject} from 'react'
import type {OverviewUtilization} from '../../core/render/overviewUtilization'
import type {SelectionStore} from './selectionStore'
import type {ViewportStore} from './viewportStore'

export const TIMELINE_OVERVIEW_HEIGHT_PX = 56

interface TimelineOverviewProps {
  overview: OverviewUtilization
  store: ViewportStore
  selectionStore: SelectionStore
  labelWidthPx: number
  /**
   * Optional ref the parent can use to attach its own pointer listeners
   * (e.g. the selection hook). Kept as a raw ref instead of forwardRef
   * so we can still own the canvas element internally and share it.
   */
  canvasRef?: MutableRefObject<HTMLCanvasElement | null>
}

/**
 * Sticky "minimap"-style overview track at the top of the timeline. Shows
 * a smoothed mountain chart of overall utilization across the entire
 * trace, dims the portions outside the current zoom window, and renders
 * the active drag-selection on top.
 *
 * Architecture mirrors {@link TimelineAxis} and the per-track canvases:
 *  - Single `<canvas>` sized to the visible content width.
 *  - Subscribes to {@link ViewportStore} and {@link SelectionStore}
 *    directly; redraws on rAF, never through React state.
 *  - Sticky `top: 0` so it stays pinned as the user scrolls tracks
 *    vertically. Stacks above tracks via `z-index`.
 *
 * The mountain itself always represents the *full* trace — it's a
 * navigational aid, not a per-viewport readout — so we sample the
 * precomputed `OverviewUtilization.buckets` at one column per CSS pixel
 * across the content area regardless of zoom. The current zoom window is
 * shown as a brighter band with dimmer "out-of-view" regions on either
 * side.
 */
function TimelineOverviewBase({
  overview,
  store,
  selectionStore,
  labelWidthPx,
  canvasRef: externalCanvasRef,
}: TimelineOverviewProps) {
  const internalCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const canvasRef = internalCanvasRef
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)

  const setCanvasEl = (el: HTMLCanvasElement | null): void => {
    canvasRef.current = el
    if (externalCanvasRef) externalCanvasRef.current = el
  }

  useEffect(() => {
    const canvas = canvasRef.current
    const wrapper = wrapperRef.current
    if (!canvas || !wrapper) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let lastWrapperWidthCss = -1
    let lastBackingWidthCss = -1
    let lastDpr = -1

    const render = (): void => {
      rafRef.current = null
      const state = store.get()
      const contentWidthCss = Math.max(
        0,
        state.viewportWidth - state.labelWidthPx,
      )
      if (contentWidthCss <= 0) return
      const heightCss = TIMELINE_OVERVIEW_HEIGHT_PX

      if (contentWidthCss !== lastWrapperWidthCss) {
        wrapper.style.width = `${contentWidthCss}px`
        lastWrapperWidthCss = contentWidthCss
      }

      const dpr = window.devicePixelRatio || 1
      if (contentWidthCss !== lastBackingWidthCss || dpr !== lastDpr) {
        canvas.style.width = `${contentWidthCss}px`
        canvas.style.height = `${heightCss}px`
        canvas.width = Math.max(1, Math.round(contentWidthCss * dpr))
        canvas.height = Math.max(1, Math.round(heightCss * dpr))
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lastBackingWidthCss = contentWidthCss
        lastDpr = dpr
      }

      ctx.clearRect(0, 0, contentWidthCss, heightCss)
      // Background. Slightly darker than the track rows so the overview
      // reads as chrome.
      ctx.fillStyle = '#0b0f17'
      ctx.fillRect(0, 0, contentWidthCss, heightCss)

      const traceStart = overview.startMs
      const traceEnd = overview.endMs
      const traceSpan = Math.max(traceEnd - traceStart, 1e-6)
      const buckets = overview.buckets
      const bucketCount = buckets.length

      // Map pixel column → bucket index. The overview always spans the
      // whole trace, independent of the main viewport's zoom.
      const msPerPx = traceSpan / contentWidthCss

      // Precompute the silhouette so the fill and stroke share the same
      // per-column y values. The mountain is drawn top-down from y = 2
      // (leaving room for a subtle top margin) to baseline at height-1.
      const topMargin = 4
      const baselineY = heightCss - 1
      const mountainTopMax = topMargin
      const mountainHeight = baselineY - mountainTopMax

      // Density-aware sampling: take max across all buckets that fall in
      // this column so a single spike never vanishes when the column
      // covers many buckets (zoomed-out traces).
      const ys = new Float32Array(Math.max(1, Math.ceil(contentWidthCss)))
      for (let x = 0; x < ys.length; x++) {
        const msAtLeft = x * msPerPx
        const msAtRight = (x + 1) * msPerPx
        const bLo = Math.min(
          bucketCount - 1,
          Math.max(0, Math.floor(msAtLeft / overview.bucketMs)),
        )
        const bHi = Math.min(
          bucketCount - 1,
          Math.max(0, Math.floor(msAtRight / overview.bucketMs)),
        )
        let maxV = 0
        for (let b = bLo; b <= bHi; b++) {
          const v = buckets[b]
          if (v > maxV) maxV = v
        }
        ys[x] = baselineY - maxV * mountainHeight
      }

      // Mountain fill: top → bottom vertical gradient. Closed path at the
      // baseline so the interior is filled.
      const grad = ctx.createLinearGradient(0, mountainTopMax, 0, baselineY)
      grad.addColorStop(0, 'rgba(99, 179, 237, 0.55)')
      grad.addColorStop(1, 'rgba(99, 179, 237, 0.05)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.moveTo(0, baselineY)
      for (let x = 0; x < ys.length; x++) {
        ctx.lineTo(x + 0.5, ys[x])
      }
      ctx.lineTo(ys.length - 1, baselineY)
      ctx.closePath()
      ctx.fill()

      // Mountain stroke. 1px top line so the silhouette stays crisp even
      // on flat regions where the gradient is barely visible.
      ctx.strokeStyle = 'rgba(144, 205, 244, 0.85)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = 0; x < ys.length; x++) {
        const px = x + 0.5
        if (x === 0) ctx.moveTo(px, ys[x])
        else ctx.lineTo(px, ys[x])
      }
      ctx.stroke()

      // Baseline.
      ctx.strokeStyle = '#2d3748'
      ctx.beginPath()
      ctx.moveTo(0, baselineY + 0.5)
      ctx.lineTo(contentWidthCss, baselineY + 0.5)
      ctx.stroke()

      // Current viewport indicator. When the user is zoomed in, dim the
      // regions outside the viewport and outline the visible window.
      const pxPerMs = state.pxPerMs
      if (pxPerMs > 0) {
        const msAtViewportLeft =
          state.timelineStart + state.scrollLeft / pxPerMs
        const viewportContentWidthCss = Math.max(
          0,
          state.viewportWidth - state.labelWidthPx,
        )
        const msAtViewportRight =
          msAtViewportLeft + viewportContentWidthCss / pxPerMs

        const viewStartX = Math.max(
          0,
          ((msAtViewportLeft - traceStart) / traceSpan) * contentWidthCss,
        )
        const viewEndX = Math.min(
          contentWidthCss,
          ((msAtViewportRight - traceStart) / traceSpan) * contentWidthCss,
        )
        const viewWidthX = Math.max(0, viewEndX - viewStartX)

        // Only bother dimming when there's something to dim (i.e. user
        // has zoomed in so the viewport is a proper subset of the
        // trace). At fit-zoom the viewport covers the full trace and
        // there's nothing to outline.
        const notFullRange =
          viewStartX > 0.5 || viewEndX < contentWidthCss - 0.5
        if (notFullRange && viewWidthX > 0) {
          ctx.fillStyle = 'rgba(11, 15, 23, 0.55)'
          if (viewStartX > 0) {
            ctx.fillRect(0, 0, viewStartX, heightCss)
          }
          if (viewEndX < contentWidthCss) {
            ctx.fillRect(viewEndX, 0, contentWidthCss - viewEndX, heightCss)
          }
          ctx.strokeStyle = 'rgba(226, 232, 240, 0.4)'
          ctx.lineWidth = 1
          ctx.strokeRect(
            Math.round(viewStartX) + 0.5,
            0.5,
            Math.max(1, Math.round(viewWidthX) - 1),
            heightCss - 1,
          )
        }
      }

      // Selection rectangle. Committed and in-progress drags both render
      // here. Uses a brighter fill so the selection pops over the
      // mountain.
      const sel = selectionStore.get()
      const range = sel.inProgress ?? sel.committed
      if (range && range.endMs > range.startMs) {
        const selStartX = Math.max(
          0,
          ((range.startMs - traceStart) / traceSpan) * contentWidthCss,
        )
        const selEndX = Math.min(
          contentWidthCss,
          ((range.endMs - traceStart) / traceSpan) * contentWidthCss,
        )
        const selWidthX = Math.max(0, selEndX - selStartX)
        if (selWidthX > 0) {
          ctx.fillStyle = 'rgba(246, 224, 94, 0.18)'
          ctx.fillRect(selStartX, 0, selWidthX, heightCss)
          ctx.strokeStyle = 'rgba(246, 224, 94, 0.9)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(Math.round(selStartX) + 0.5, 0)
          ctx.lineTo(Math.round(selStartX) + 0.5, heightCss)
          ctx.moveTo(Math.round(selEndX) - 0.5, 0)
          ctx.lineTo(Math.round(selEndX) - 0.5, heightCss)
          ctx.stroke()
        }
      }
    }

    const schedule = (): void => {
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(render)
    }

    schedule()
    const unsubscribeViewport = store.subscribe(() => schedule())
    const unsubscribeSelection = selectionStore.subscribe(() => schedule())

    const dprMedia =
      typeof window.matchMedia === 'function'
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        : null
    const onDprChange = (): void => schedule()
    dprMedia?.addEventListener?.('change', onDprChange)

    return () => {
      unsubscribeViewport()
      unsubscribeSelection()
      dprMedia?.removeEventListener?.('change', onDprChange)
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [overview, store, selectionStore])

  return (
    <div
      data-testid="timeline-overview"
      className="border-b border-[#2d3748] bg-[#0b0f17]"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        position: 'sticky',
        top: 0,
        zIndex: 3,
        height: TIMELINE_OVERVIEW_HEIGHT_PX,
        width: '100%',
      }}
    >
      <div
        aria-hidden
        className="border-r border-[#2d3748] bg-[#0b0f17] flex items-center px-3 text-[10px] uppercase tracking-wider text-[#718096]"
        style={{
          position: 'sticky',
          left: 0,
          top: 0,
          zIndex: 1,
          flexShrink: 0,
          width: labelWidthPx,
          height: TIMELINE_OVERVIEW_HEIGHT_PX,
        }}
      >
        Overview
      </div>
      <div
        ref={wrapperRef}
        data-testid="timeline-overview-canvas-wrapper"
        style={{
          position: 'sticky',
          left: labelWidthPx,
          top: 0,
          flexShrink: 0,
          height: TIMELINE_OVERVIEW_HEIGHT_PX,
          width: 0,
          display: 'block',
        }}
      >
        <canvas
          ref={setCanvasEl}
          data-testid="timeline-overview-canvas"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: TIMELINE_OVERVIEW_HEIGHT_PX,
            display: 'block',
            // Left-drag on this canvas starts a time-range selection
            // (see useTimelineSelection). Pointer events stay enabled so
            // the selection hook can attach listeners here.
            cursor: 'crosshair',
          }}
        />
      </div>
    </div>
  )
}

export default memo(TimelineOverviewBase)
