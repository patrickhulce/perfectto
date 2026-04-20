import {memo, useEffect, useRef} from 'react'
import {computeAxisTicks} from './timeAxis'
import type {ViewportStore} from './viewportStore'

export const TIMELINE_AXIS_HEIGHT_PX = 28

interface TimelineAxisProps {
  store: ViewportStore
  labelWidthPx: number
}

/**
 * Sticky top ruler. Renders major + minor time ticks, labelled majors,
 * and the baseline separator above the tracks.
 *
 * Architecture mirrors `CanvasTrackRenderer`:
 *  - subscribes to `ViewportStore` directly and redraws via rAF, so
 *    React never renders on scroll/zoom;
 *  - backed by a single `<canvas>` the width of the visible track area;
 *  - styled as `position: sticky; top: 0` so it stays pinned while the
 *    user vertically scrolls through tracks.
 *
 * Unlike track canvases this does NOT use the 3× skirt. The axis is
 * cheap to redraw (a few dozen tick lines + labels) and recomputing
 * ticks on every scroll keeps the label text snapped to integer tick
 * positions without the sub-pixel shimmer a translate-only path would
 * introduce.
 */
function TimelineAxisBase({store, labelWidthPx}: TimelineAxisProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)

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
      const pxPerMs = state.pxPerMs
      if (pxPerMs <= 0) return
      const contentWidthCss = Math.max(
        0,
        state.viewportWidth - state.labelWidthPx,
      )
      if (contentWidthCss <= 0) return

      if (contentWidthCss !== lastWrapperWidthCss) {
        wrapper.style.width = `${contentWidthCss}px`
        lastWrapperWidthCss = contentWidthCss
      }

      const dpr = window.devicePixelRatio || 1
      if (contentWidthCss !== lastBackingWidthCss || dpr !== lastDpr) {
        canvas.style.width = `${contentWidthCss}px`
        canvas.style.height = `${TIMELINE_AXIS_HEIGHT_PX}px`
        canvas.width = Math.max(1, Math.round(contentWidthCss * dpr))
        canvas.height = Math.max(1, Math.round(TIMELINE_AXIS_HEIGHT_PX * dpr))
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        lastBackingWidthCss = contentWidthCss
        lastDpr = dpr
      }

      const msAtLeft = state.timelineStart + state.scrollLeft / pxPerMs
      const msAtRight = msAtLeft + contentWidthCss / pxPerMs
      const ticks = computeAxisTicks({
        timelineStart: state.timelineStart,
        timelineEnd: state.timelineEnd,
        pxPerMs,
        rangeStartMs: msAtLeft,
        rangeEndMs: msAtRight,
      })

      ctx.clearRect(0, 0, contentWidthCss, TIMELINE_AXIS_HEIGHT_PX)
      // Axis background. Matches the track row background so the ruler
      // reads as part of the chrome rather than floating over content.
      ctx.fillStyle = '#0f1319'
      ctx.fillRect(0, 0, contentWidthCss, TIMELINE_AXIS_HEIGHT_PX)

      const baselineY = TIMELINE_AXIS_HEIGHT_PX - 0.5
      // Bottom rule. The 0.5 fractional y lands the stroke inside a
      // single device pixel at dpr=1, avoiding blurry 2-pixel lines.
      ctx.strokeStyle = '#2d3748'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, baselineY)
      ctx.lineTo(contentWidthCss, baselineY)
      ctx.stroke()

      // Minor ticks: short strokes from the baseline upward, dimmer
      // than majors. Draw before majors so majors always paint on top.
      if (ticks.minorTicksMs.length > 0) {
        ctx.strokeStyle = '#2d3748'
        ctx.beginPath()
        for (let i = 0; i < ticks.minorTicksMs.length; i++) {
          const x =
            (ticks.minorTicksMs[i] - state.timelineStart) * pxPerMs -
            state.scrollLeft
          const xPx = Math.round(x) + 0.5
          ctx.moveTo(xPx, baselineY)
          ctx.lineTo(xPx, baselineY - 5)
        }
        ctx.stroke()
      }

      // Major ticks: full-height strokes + labels.
      ctx.strokeStyle = '#4a5568'
      ctx.beginPath()
      for (let i = 0; i < ticks.majorTicksMs.length; i++) {
        const x =
          (ticks.majorTicksMs[i] - state.timelineStart) * pxPerMs -
          state.scrollLeft
        const xPx = Math.round(x) + 0.5
        ctx.moveTo(xPx, baselineY)
        ctx.lineTo(xPx, baselineY - 10)
      }
      ctx.stroke()

      // Labels. One font setup for the whole batch — `fillText` is cheap
      // once ctx.font is stable. Text is left-anchored to the tick so
      // the number starts just right of the tick line.
      ctx.fillStyle = '#a0aec0'
      ctx.font = '10px system-ui, -apple-system, sans-serif'
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      for (let i = 0; i < ticks.majorTicksMs.length; i++) {
        const ms = ticks.majorTicksMs[i]
        const x = (ms - state.timelineStart) * pxPerMs - state.scrollLeft
        const xPx = Math.round(x) + 3
        // Suppress labels that would bleed past the right edge; the next
        // tick will pick them up on the next pan frame.
        if (xPx > contentWidthCss - 4) continue
        ctx.fillText(ticks.labelFor(ms), xPx, 2)
      }
    }

    const schedule = (): void => {
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(render)
    }

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
  }, [store])

  return (
    <div
      data-testid="timeline-axis"
      className="border-b border-[#2d3748] bg-[#0f1319]"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        // Stick to the top of the scroller. z-index keeps the axis above
        // track content during vertical scroll.
        position: 'sticky',
        top: 0,
        zIndex: 2,
        height: TIMELINE_AXIS_HEIGHT_PX,
        width: '100%',
      }}
    >
      {/*
        Gutter spacer. Sticky at left:0 so the axis labels never start
        underneath the label column. Matches the CanvasTrackRenderer
        gutter pattern so the two align pixel-perfect.
      */}
      <div
        aria-hidden
        className="border-r border-[#2d3748] bg-[#0f1319]"
        style={{
          position: 'sticky',
          left: 0,
          top: 0,
          zIndex: 1,
          flexShrink: 0,
          width: labelWidthPx,
          height: TIMELINE_AXIS_HEIGHT_PX,
        }}
      />
      <div
        ref={wrapperRef}
        className="pointer-events-none"
        style={{
          position: 'sticky',
          left: labelWidthPx,
          top: 0,
          flexShrink: 0,
          height: TIMELINE_AXIS_HEIGHT_PX,
          // Width set imperatively from the store.
          width: 0,
          display: 'block',
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="timeline-axis-canvas"
          className="pointer-events-none"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            height: TIMELINE_AXIS_HEIGHT_PX,
            display: 'block',
          }}
        />
      </div>
    </div>
  )
}

export default memo(TimelineAxisBase)
