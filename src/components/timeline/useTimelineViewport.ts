import {useCallback, useEffect, useRef, useState, type RefObject} from 'react'

export interface TimelineBounds {
  start: number
  end: number
}

export interface UseTimelineZoomOptions {
  bounds: TimelineBounds
  /**
   * Width of the label gutter in pixels. Measures are positioned starting at
   * `labelWidthPx` so the sticky label sits cleanly to the left of them.
   */
  labelWidthPx: number
  /**
   * Current pixel width of the outer scroll container. Used to compute the
   * initial "fit" zoom so the full trace fills the viewport before the user
   * zooms manually.
   */
  containerWidthPx: number
  /**
   * Ref to the scroll container whose `scrollLeft` represents pan.
   * Ctrl/meta + wheel zoom and left-button drag update this directly.
   */
  scrollerRef: RefObject<HTMLElement | null>
}

export interface UseTimelineZoomResult {
  pxPerMs: number
  /** Attach to the element that should receive wheel + pointer gestures. */
  eventTargetRef: (el: HTMLElement | null) => void
}

const MIN_SPAN_MS = 0.01
/** Hard cap on zoom-in so we never divide by ~zero. */
const MAX_PX_PER_MS = 1e6
/**
 * Soft cap on the total inner-surface width. Browsers differ, but ~20M px is a
 * safe ceiling across Chromium/Safari/Firefox. We clamp `pxPerMs` so
 * `totalSpan * pxPerMs` stays under this.
 */
const MAX_CONTENT_WIDTH_PX = 20_000_000

function clampPxPerMs(value: number, totalSpan: number): number {
  const maxByWidth =
    totalSpan > 0 ? MAX_CONTENT_WIDTH_PX / totalSpan : MAX_PX_PER_MS
  const lo = 1e-9
  const hi = Math.min(MAX_PX_PER_MS, maxByWidth)
  if (!Number.isFinite(value) || value <= 0) return lo
  return Math.max(lo, Math.min(hi, value))
}

export function useTimelineZoom(
  options: UseTimelineZoomOptions,
): UseTimelineZoomResult {
  const {bounds, labelWidthPx, containerWidthPx, scrollerRef} = options

  const totalSpan = Math.max(bounds.end - bounds.start, MIN_SPAN_MS)
  const fitPxPerMs = containerWidthPx > 0 ? containerWidthPx / totalSpan : 0

  // `null` means "follow the fit zoom". As soon as the user zooms, we pin
  // `pxPerMs` explicitly and ignore subsequent container-width changes.
  const [pxPerMsOverride, setPxPerMsOverride] = useState<number | null>(null)
  const pxPerMs = pxPerMsOverride ?? fitPxPerMs

  // When the underlying trace changes, reset to fit.
  useEffect(() => {
    setPxPerMsOverride(null)
  }, [bounds.start, bounds.end])

  const pxPerMsRef = useRef(pxPerMs)
  pxPerMsRef.current = pxPerMs
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  const labelWidthRef = useRef(labelWidthPx)
  labelWidthRef.current = labelWidthPx

  const [eventEl, setEventEl] = useState<HTMLElement | null>(null)
  const eventTargetRef = useCallback((el: HTMLElement | null) => {
    setEventEl(el)
  }, [])

  useEffect(() => {
    const el = eventEl
    if (!el) return

    const onWheel = (e: WheelEvent): void => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const zooming = e.ctrlKey || e.metaKey
      if (!zooming) return // native scroll handles pan in both axes
      e.preventDefault()

      const rect = scroller.getBoundingClientRect()
      const cursorXInViewport = Math.max(
        0,
        Math.min(e.clientX - rect.left, scroller.clientWidth),
      )
      const labelWidth = labelWidthRef.current
      const innerX = scroller.scrollLeft + cursorXInViewport
      const trackX = innerX - labelWidth
      const b = boundsRef.current
      const span = Math.max(b.end - b.start, MIN_SPAN_MS)
      const current = pxPerMsRef.current
      const anchorMs =
        current > 0
          ? b.start + Math.max(0, trackX) / current
          : b.start

      const scale = Math.exp(e.deltaY * 0.0015)
      const next = clampPxPerMs(current / scale, span)
      if (next === current) return

      // Keep the anchor ms pinned under the cursor after the zoom.
      const newTrackX = (anchorMs - b.start) * next
      const newScrollLeft = newTrackX + labelWidth - cursorXInViewport
      setPxPerMsOverride(next)
      scroller.scrollLeft = newScrollLeft
    }

    // Safari trackpad pinch dispatches gesture events instead of ctrl+wheel;
    // swallow them so the page can't zoom.
    const onGesture = (e: Event): void => {
      e.preventDefault()
    }

    let panning:
      | {pointerId: number; startClientX: number; startScrollLeft: number}
      | null = null

    const onPointerDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      if (target?.closest('button, input, textarea, [data-no-pan]')) return
      const scroller = scrollerRef.current
      if (!scroller) return
      panning = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startScrollLeft: scroller.scrollLeft,
      }
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        // setPointerCapture can throw if the target isn't capture-eligible; ignore.
      }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!panning || e.pointerId !== panning.pointerId) return
      const scroller = scrollerRef.current
      if (!scroller) return
      const dx = e.clientX - panning.startClientX
      if (dx === 0) return
      scroller.scrollLeft = panning.startScrollLeft - dx
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
    el.addEventListener('gesturestart', onGesture as EventListener)
    el.addEventListener('gesturechange', onGesture as EventListener)
    el.addEventListener('gestureend', onGesture as EventListener)

    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', endPan)
      el.removeEventListener('pointercancel', endPan)
      el.removeEventListener('gesturestart', onGesture as EventListener)
      el.removeEventListener('gesturechange', onGesture as EventListener)
      el.removeEventListener('gestureend', onGesture as EventListener)
    }
  }, [eventEl, scrollerRef])

  return {pxPerMs, eventTargetRef}
}
