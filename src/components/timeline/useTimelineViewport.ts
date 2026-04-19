import {useEffect, useRef, useState, type RefObject} from 'react'
import {ViewportStore} from './viewportStore'

export interface TimelineBounds {
  start: number
  end: number
}

export interface UseTimelineZoomOptions {
  bounds: TimelineBounds
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
  /** Store to publish viewport updates into. */
  store: ViewportStore
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
/**
 * Effective deltaY equivalent per W/S keypress. Matched to a single wheel
 * notch (~100) so keyboard and trackpad zoom feel identical.
 */
const KEY_ZOOM_DELTA_Y = 80
const KEY_PAN_VIEWPORT_FRACTION = 0.1
const KEY_PAN_MIN_PX = 60

function clampPxPerMs(value: number, totalSpan: number): number {
  const maxByWidth =
    totalSpan > 0 ? MAX_CONTENT_WIDTH_PX / totalSpan : MAX_PX_PER_MS
  const lo = 1e-9
  const hi = Math.min(MAX_PX_PER_MS, maxByWidth)
  if (!Number.isFinite(value) || value <= 0) return lo
  return Math.max(lo, Math.min(hi, value))
}

/**
 * Zoom + pan controller for the canvas-based timeline.
 *
 * Every gesture tick is committed immediately: wheel/W/S recompute `pxPerMs`,
 * recompute the scroll offset that keeps the anchor point under the cursor,
 * write the DOM `scrollLeft`, and publish the new state to the shared
 * `ViewportStore`. No transform tricks, no debounced commit, no flushSync —
 * every canvas subscriber schedules its own rAF and redraws on the next
 * frame, so the gesture still feels instant without paying a React render
 * tax per tick.
 *
 * The React-visible `pxPerMs` return is only used by code that must size the
 * inner surface width (a single React element). Canvases read the store
 * directly and never re-render during scroll/zoom.
 */
export function useTimelineZoom(
  options: UseTimelineZoomOptions,
): UseTimelineZoomResult {
  const {bounds, labelWidthPx, containerWidthPx, scrollerRef, store} = options

  const totalSpan = Math.max(bounds.end - bounds.start, MIN_SPAN_MS)
  const fitPxPerMs = containerWidthPx > 0 ? containerWidthPx / totalSpan : 0

  // `null` means "follow the fit zoom". As soon as the user zooms, we pin
  // `pxPerMs` explicitly and ignore subsequent container-width changes.
  const [pxPerMsOverride, setPxPerMsOverride] = useState<number | null>(null)
  const pxPerMs = pxPerMsOverride ?? fitPxPerMs

  // Reset to fit when the underlying trace changes.
  useEffect(() => {
    setPxPerMsOverride(null)
  }, [bounds.start, bounds.end])

  // Stash the latest committed values in refs so the event handlers can
  // read them without re-attaching the listener effect every render.
  const pxPerMsRef = useRef(pxPerMs)
  pxPerMsRef.current = pxPerMs
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds
  const labelWidthRef = useRef(labelWidthPx)
  labelWidthRef.current = labelWidthPx
  const storeRef = useRef(store)
  storeRef.current = store

  // Keep the store's pxPerMs / labelWidthPx / bounds in sync with props even
  // outside a gesture (e.g. after the window resizes and fitPxPerMs changes).
  useEffect(() => {
    store.set({
      pxPerMs,
      labelWidthPx,
      timelineStart: bounds.start,
      timelineEnd: bounds.end,
    })
  }, [store, pxPerMs, labelWidthPx, bounds.start, bounds.end])

  const [eventEl, setEventEl] = useState<HTMLElement | null>(null)
  const eventTargetRef = (el: HTMLElement | null): void => {
    setEventEl(el)
  }

  useEffect(() => {
    const el = eventEl
    if (!el) return

    let lastCursorClientX = 0
    let cursorOverTimeline = false

    /**
     * Recompute `pxPerMs` and the scroll offset that pins `anchorClientX` to
     * the same timeline ms before vs after the zoom. Writes the DOM
     * scrollLeft, bumps React state (so the inner surface width updates),
     * and publishes the new viewport snapshot.
     */
    const applyZoom = (deltaY: number, anchorClientX: number): void => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const span = Math.max(
        boundsRef.current.end - boundsRef.current.start,
        MIN_SPAN_MS,
      )
      const committed = pxPerMsRef.current
      if (committed <= 0) return

      const scaleMultiplier = Math.exp(-deltaY * 0.0015)
      const targetPxPerMs = clampPxPerMs(committed * scaleMultiplier, span)
      if (targetPxPerMs === committed) return

      const labelWidth = labelWidthRef.current
      const rect = scroller.getBoundingClientRect()
      const cursorXInViewport = Math.max(
        0,
        Math.min(anchorClientX - rect.left, scroller.clientWidth),
      )
      // Layer-x of the timeline ms currently under the cursor.
      const scrollLeft = scroller.scrollLeft
      const anchorLayerX = scrollLeft + cursorXInViewport - labelWidth
      const anchorMs = boundsRef.current.start + anchorLayerX / committed
      // Solve for scrollLeft such that the same ms is under the cursor at
      // the new pxPerMs.
      const targetScrollLeft =
        labelWidth +
        (anchorMs - boundsRef.current.start) * targetPxPerMs -
        cursorXInViewport

      // Update the React-facing pxPerMs BEFORE writing scrollLeft, so the
      // inner surface width grows to accommodate the new scroll target and
      // the browser doesn't clamp our write. React 19 batches within this
      // task; paint happens once at the end.
      pxPerMsRef.current = targetPxPerMs
      setPxPerMsOverride(targetPxPerMs)
      scroller.scrollLeft = targetScrollLeft

      storeRef.current.set({
        pxPerMs: targetPxPerMs,
        scrollLeft: targetScrollLeft,
      })
    }

    const onWheel = (e: WheelEvent): void => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const zooming = e.ctrlKey || e.metaKey
      if (!zooming) return // native scroll handles pan in both axes
      e.preventDefault()
      applyZoom(e.deltaY, e.clientX)
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
        // setPointerCapture can throw if the target isn't capture-eligible;
        // ignore.
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
        // no-op
      }
      panning = null
    }

    // Track the cursor position so WASD zoom can anchor at it even when no
    // pointer gesture is active.
    const onPointerMoveTrack = (e: PointerEvent): void => {
      lastCursorClientX = e.clientX
      cursorOverTimeline = true
    }
    const onPointerLeaveTrack = (): void => {
      cursorOverTimeline = false
    }

    const shouldHandleKey = (e: KeyboardEvent): boolean => {
      if (e.ctrlKey || e.metaKey || e.altKey) return false
      const active = document.activeElement as HTMLElement | null
      if (!active) return true
      const tag = active.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false
      if (active.isContentEditable) return false
      return true
    }

    const resolveZoomAnchor = (): number => {
      const scroller = scrollerRef.current
      if (!scroller) return lastCursorClientX
      const rect = scroller.getBoundingClientRect()
      if (
        cursorOverTimeline &&
        lastCursorClientX >= rect.left &&
        lastCursorClientX <= rect.right
      ) {
        return lastCursorClientX
      }
      // Keyboard-only workflow: anchor zoom at the center of the timeline
      // viewport so W/S feel like "zoom around what I'm looking at" rather
      // than around a stale mouse position.
      return rect.left + rect.width / 2
    }

    const keyboardPan = (deltaPx: number): void => {
      const scroller = scrollerRef.current
      if (!scroller) return
      scroller.scrollLeft += deltaPx
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!shouldHandleKey(e)) return
      switch (e.key) {
        case 'w':
        case 'W':
          e.preventDefault()
          applyZoom(-KEY_ZOOM_DELTA_Y, resolveZoomAnchor())
          break
        case 's':
        case 'S':
          e.preventDefault()
          applyZoom(KEY_ZOOM_DELTA_Y, resolveZoomAnchor())
          break
        case 'a':
        case 'A': {
          const scroller = scrollerRef.current
          if (!scroller) return
          e.preventDefault()
          const step = Math.max(
            KEY_PAN_MIN_PX,
            scroller.clientWidth * KEY_PAN_VIEWPORT_FRACTION,
          )
          keyboardPan(-step)
          break
        }
        case 'd':
        case 'D': {
          const scroller = scrollerRef.current
          if (!scroller) return
          e.preventDefault()
          const step = Math.max(
            KEY_PAN_MIN_PX,
            scroller.clientWidth * KEY_PAN_VIEWPORT_FRACTION,
          )
          keyboardPan(step)
          break
        }
      }
    }

    el.addEventListener('wheel', onWheel, {passive: false})
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointermove', onPointerMoveTrack)
    el.addEventListener('pointerleave', onPointerLeaveTrack)
    el.addEventListener('pointerup', endPan)
    el.addEventListener('pointercancel', endPan)
    el.addEventListener('gesturestart', onGesture as EventListener)
    el.addEventListener('gesturechange', onGesture as EventListener)
    el.addEventListener('gestureend', onGesture as EventListener)
    window.addEventListener('keydown', onKeyDown)

    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointermove', onPointerMoveTrack)
      el.removeEventListener('pointerleave', onPointerLeaveTrack)
      el.removeEventListener('pointerup', endPan)
      el.removeEventListener('pointercancel', endPan)
      el.removeEventListener('gesturestart', onGesture as EventListener)
      el.removeEventListener('gesturechange', onGesture as EventListener)
      el.removeEventListener('gestureend', onGesture as EventListener)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [eventEl, scrollerRef])

  return {pxPerMs, eventTargetRef}
}
