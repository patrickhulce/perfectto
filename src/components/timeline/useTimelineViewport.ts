import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react'

export interface Viewport {
  /** Leftmost visible time in ms. */
  startMs: number
  /** Rightmost visible time in ms. */
  endMs: number
  /** Derived: containerWidthPx / (end - start). */
  pxPerMs: number
  /** Width of the track region in pixels (excluding any label gutter). */
  containerWidthPx: number
  timeToPx: (t: number) => number
}

export interface TimelineBounds {
  start: number
  end: number
}

export interface UseTimelineViewportOptions {
  bounds: TimelineBounds
  /**
   * Current pixel width of the track region (i.e. the space events will be
   * laid out in). Caller is responsible for measuring this, since in our
   * layout the track region sits next to a fixed-width label gutter.
   */
  containerWidthPx: number
}

export interface UseTimelineViewportResult {
  viewport: Viewport
  /** Attach to the element that should receive wheel + pointer events. */
  eventTargetRef: (el: HTMLElement | null) => void
}

interface ViewportRange {
  startMs: number
  endMs: number
}

const MIN_SPAN_MS = 0.01
/** Hard cap on zoom-in so we never divide by ~zero. */
const MAX_PX_PER_MS = 1e6

export function useTimelineViewport(
  options: UseTimelineViewportOptions,
): UseTimelineViewportResult {
  const {bounds, containerWidthPx} = options

  const [range, setRange] = useState<ViewportRange>({
    startMs: bounds.start,
    endMs: bounds.end,
  })

  const widthRef = useRef(containerWidthPx)
  widthRef.current = containerWidthPx
  const rangeRef = useRef(range)
  rangeRef.current = range
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds

  const [eventEl, setEventEl] = useState<HTMLElement | null>(null)
  const eventTargetRef = useCallback((el: HTMLElement | null) => {
    setEventEl(el)
  }, [])

  useLayoutEffect(() => {
    setRange({startMs: bounds.start, endMs: bounds.end})
  }, [bounds.start, bounds.end])

  useEffect(() => {
    const el = eventEl
    if (!el) return

    const clampRange = (next: ViewportRange): ViewportRange => {
      const b = boundsRef.current
      const minSpan = Math.max(widthRef.current / MAX_PX_PER_MS, MIN_SPAN_MS)
      let {startMs, endMs} = next
      if (endMs - startMs < minSpan) endMs = startMs + minSpan
      const totalSpan = Math.max(b.end - b.start, MIN_SPAN_MS)
      const visibleSpan = Math.min(endMs - startMs, totalSpan)
      if (visibleSpan !== endMs - startMs) {
        endMs = startMs + visibleSpan
      }
      if (startMs < b.start) {
        const shift = b.start - startMs
        startMs += shift
        endMs += shift
      }
      if (endMs > b.end) {
        const shift = endMs - b.end
        startMs -= shift
        endMs -= shift
      }
      return {startMs, endMs}
    }

    const onWheel = (e: WheelEvent): void => {
      if (widthRef.current <= 0) return
      const zooming = e.ctrlKey || e.metaKey
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)

      if (zooming) {
        e.preventDefault()
        const rect = el.getBoundingClientRect()
        const cursorPx = Math.max(0, Math.min(e.clientX - rect.left, widthRef.current))
        const {startMs, endMs} = rangeRef.current
        const spanMs = endMs - startMs
        const anchorMs = startMs + (cursorPx / widthRef.current) * spanMs
        const scale = Math.exp(e.deltaY * 0.0015)
        const nextSpan = Math.max(spanMs * scale, widthRef.current / MAX_PX_PER_MS)
        const ratio = cursorPx / widthRef.current
        const nextStart = anchorMs - ratio * nextSpan
        const nextEnd = nextStart + nextSpan
        setRange(prev => {
          const clamped = clampRange({startMs: nextStart, endMs: nextEnd})
          if (clamped.startMs === prev.startMs && clamped.endMs === prev.endMs) return prev
          return clamped
        })
        return
      }

      if (e.shiftKey || horizontal) {
        e.preventDefault()
        const {startMs, endMs} = rangeRef.current
        const spanMs = endMs - startMs
        const delta = ((horizontal ? e.deltaX : e.deltaY) / widthRef.current) * spanMs
        setRange(prev => {
          const next = clampRange({startMs: prev.startMs + delta, endMs: prev.endMs + delta})
          if (next.startMs === prev.startMs) return prev
          return next
        })
      }
    }

    let panning:
      | {pointerId: number; startClientX: number; startRange: ViewportRange}
      | null = null

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      if (target?.closest('button, input, textarea, [data-no-pan]')) return
      if (widthRef.current <= 0) return
      panning = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startRange: rangeRef.current,
      }
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // setPointerCapture can throw if the target isn't capture-eligible; ignore.
      }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!panning || e.pointerId !== panning.pointerId) return
      const dx = e.clientX - panning.startClientX
      if (dx === 0) return
      const spanMs = panning.startRange.endMs - panning.startRange.startMs
      const deltaMs = -(dx / widthRef.current) * spanMs
      setRange(() =>
        clampRange({
          startMs: panning!.startRange.startMs + deltaMs,
          endMs: panning!.startRange.endMs + deltaMs,
        }),
      )
    }

    const endPan = (e: PointerEvent): void => {
      if (!panning || e.pointerId !== panning.pointerId) return
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // No-op.
      }
      panning = null
    }

    el.addEventListener('wheel', onWheel, {passive: false})
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', endPan)
    el.addEventListener('pointercancel', endPan)

    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', endPan)
      el.removeEventListener('pointercancel', endPan)
    }
  }, [eventEl])

  const effectiveSpan = Math.max(range.endMs - range.startMs, MIN_SPAN_MS)
  const pxPerMs = containerWidthPx > 0 ? containerWidthPx / effectiveSpan : 0
  const {startMs, endMs} = range
  const timeToPx = (t: number): number => (t - startMs) * pxPerMs

  return {
    viewport: {
      startMs,
      endMs,
      pxPerMs,
      containerWidthPx,
      timeToPx,
    },
    eventTargetRef,
  }
}
