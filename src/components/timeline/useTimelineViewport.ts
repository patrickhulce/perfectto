import {useEffect, useRef, useState, type RefObject} from 'react'
import {ViewportStore} from './viewportStore'
import type {SelectionStore} from './selectionStore'

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
   * Ref to the scroll container whose `scrollLeft` / `scrollTop` represent pan.
   * Ctrl/meta + wheel zoom and middle-button drag update these directly.
   */
  scrollerRef: RefObject<HTMLElement | null>
  /** Store to publish viewport updates into. */
  store: ViewportStore
  /**
   * Selection store, used by the `Z` hotkey to zoom to the current
   * committed selection and by `Escape`/`Shift+Z` to clear it. Optional
   * for backwards compatibility with tests that don't render the
   * selection UI.
   */
  selectionStore?: SelectionStore
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
 * Base effective deltaY per W/S keypress before scaling. Matched to a single
 * wheel notch (~100) so keyboard and trackpad zoom feel identical at scale 1.
 */
const KEY_ZOOM_DELTA_Y = 80
const KEY_PAN_VIEWPORT_FRACTION = 0.1
const KEY_PAN_MIN_PX = 60
/** Multiplier for W/S zoom steps and A/D pan steps (keyboard navigation). */
const KEYBOARD_NAV_SCALE = 3

function clampPxPerMs(
  value: number,
  totalSpan: number,
  minByFit: number,
): number {
  const maxByWidth =
    totalSpan > 0 ? MAX_CONTENT_WIDTH_PX / totalSpan : MAX_PX_PER_MS
  // `minByFit` is the pxPerMs at which innerWidthPx === viewport content
  // width — i.e. the timeline exactly fills the track area with no
  // horizontal scroll. Zooming out past this is disallowed: it would only
  // produce an uncovered gap on the right (the "broken background" from
  // the feedback screenshot) and has no analogue in Perfetto or Chrome
  // DevTools. We still require a strictly positive lower bound so the
  // very first mount (containerWidthPx === 0) doesn't collapse to zero.
  const lo = Math.max(1e-9, minByFit)
  const hi = Math.max(lo, Math.min(MAX_PX_PER_MS, maxByWidth))
  if (!Number.isFinite(value) || value <= 0) return lo
  return Math.max(lo, Math.min(hi, value))
}

/**
 * Zoom + pan controller for the canvas-based timeline.
 *
 * Mouse model (updated):
 *  - Left-button drag is OWNED by `useTimelineSelection` — it creates a
 *    time-range selection. This hook no longer starts a pan on left.
 *  - Middle-button drag pans (both horizontal and vertical).
 *  - Wheel = scroll; Ctrl/Cmd + wheel = zoom around cursor.
 *  - W / S zoom around cursor (or viewport center when cursor is outside).
 *    A / D pan horizontally.
 *  - Z zooms to the current committed selection; Shift+Z / Escape clear it.
 *
 * Every gesture tick is committed immediately: wheel/W/S recompute
 * `pxPerMs`, recompute the scroll offset that keeps the anchor point
 * under the cursor, write the DOM `scrollLeft`, and publish the new
 * state to the shared `ViewportStore`. No transform tricks, no debounced
 * commit — every canvas subscriber schedules its own rAF and redraws on
 * the next frame, so the gesture still feels instant without paying a
 * React render tax per tick.
 *
 * The React-visible `pxPerMs` return is only used by code that must size
 * the inner surface width (a single React element). Canvases read the
 * store directly and never re-render during scroll/zoom.
 */
export function useTimelineZoom(
  options: UseTimelineZoomOptions,
): UseTimelineZoomResult {
  const {bounds, labelWidthPx, containerWidthPx, scrollerRef, store, selectionStore} = options

  const totalSpan = Math.max(bounds.end - bounds.start, MIN_SPAN_MS)
  // "Fit" means `innerWidthPx === containerWidthPx` — the surface exactly
  // fills the visible track area with no horizontal scroll. innerWidthPx
  // is `labelWidthPx + totalSpan * pxPerMs`, so fitPxPerMs subtracts the
  // sticky label gutter. Previously this was `containerWidthPx /
  // totalSpan`, which over-shot by labelWidth and put the timeline in a
  // permanently-scrolled state at "fit" (#3) plus caused layout shift
  // when zooming across the fit threshold (#4).
  const contentWidthPx = Math.max(0, containerWidthPx - labelWidthPx)
  const fitPxPerMs = contentWidthPx > 0 ? contentWidthPx / totalSpan : 0

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
  // Kept in a ref so applyZoom can read the current fit without
  // re-attaching its listener whenever the viewport resizes.
  const fitPxPerMsRef = useRef(fitPxPerMs)
  fitPxPerMsRef.current = fitPxPerMs
  const selectionStoreRef = useRef(selectionStore)
  selectionStoreRef.current = selectionStore

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
      const targetPxPerMs = clampPxPerMs(
        committed * scaleMultiplier,
        span,
        fitPxPerMsRef.current,
      )
      if (targetPxPerMs === committed) return

      const labelWidth = labelWidthRef.current
      const rect = scroller.getBoundingClientRect()
      const cursorXInViewport = Math.max(
        0,
        Math.min(anchorClientX - rect.left, scroller.clientWidth),
      )
      // Layer-x of the timeline ms currently under the cursor. Read the
      // precise (sub-pixel) scrollLeft from the store, not `scroller.
      // scrollLeft`, because browsers round DOM scrollLeft to integer
      // pixels on every write. Across a 20-tick zoom burst that rounding
      // compounds into ~12px of anchor drift. The store holds the exact
      // value we wrote on the previous tick; Timeline's native scroll
      // listener echo-suppresses so this value isn't clobbered by the
      // browser rounding our own write back at us.
      const storeScrollLeft = storeRef.current.get().scrollLeft
      const scrollLeft = Number.isFinite(storeScrollLeft)
        ? storeScrollLeft
        : scroller.scrollLeft
      const anchorLayerX = scrollLeft + cursorXInViewport - labelWidth
      const anchorMs = boundsRef.current.start + anchorLayerX / committed
      // Solve for scrollLeft such that the same ms is under the cursor at
      // the new pxPerMs.
      const targetScrollLeft =
        labelWidth +
        (anchorMs - boundsRef.current.start) * targetPxPerMs -
        cursorXInViewport

      // The browser clamps `scroller.scrollLeft = X` to the current
      // scrollWidth. Our scrollWidth is `labelWidth + totalSpan *
      // committed` RIGHT NOW, because React hasn't committed
      // `setPxPerMsOverride(targetPxPerMs)` yet (React 19 still batches
      // state updates set inside event handlers — the comment that used
      // to live here was wrong). If we just write scrollLeft first, a
      // zoom-in tick gets clamped to the old max, the native scroll
      // listener publishes that clamped value into the store, and the
      // anchor drifts several pixels per tick.
      //
      // Fix: imperatively widen the event-surface element BEFORE writing
      // scrollLeft, so the browser has the headroom to accept our write.
      // React's next render will set `style.width` to the exact same
      // value (innerWidthPx = labelWidth + totalSpan * targetPxPerMs),
      // so there's no flicker or double-commit — the imperative write
      // just races React to the DOM.
      pxPerMsRef.current = targetPxPerMs
      const nextInnerWidthPx = labelWidth + span * targetPxPerMs
      const surfaceEl = el as HTMLElement
      // `scroller.firstElementChild` would also work, but `el` is already
      // the event surface we got wired to (same element the JSX binds
      // `style={{width: innerWidthPx, ...}}` to).
      if (
        surfaceEl.style.width === '' ||
        parseFloat(surfaceEl.style.width) < nextInnerWidthPx
      ) {
        surfaceEl.style.width = `${nextInnerWidthPx}px`
      }
      scroller.scrollLeft = targetScrollLeft
      setPxPerMsOverride(targetPxPerMs)

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
      | {
          pointerId: number
          startClientX: number
          startClientY: number
          startScrollLeft: number
          startScrollTop: number
          button: number
          /** Inline `cursor` before middle-button pan; restore on release. */
          cursorBefore?: string
        }
      | null = null

    const onPointerDown = (e: PointerEvent): void => {
      // Only middle-button (1) starts a pan now. Left-button is owned by
      // `useTimelineSelection` and used for drag-selection. Right-click
      // falls through to the native context menu.
      if (e.button !== 1) return
      const scroller = scrollerRef.current
      if (!scroller) return
      // preventDefault on middle-click suppresses Chrome's classic
      // auto-scroll cursor (the four-arrow widget) so the drag behaves
      // like a regular pan.
      e.preventDefault()
      panning = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startScrollLeft: scroller.scrollLeft,
        startScrollTop: scroller.scrollTop,
        button: e.button,
        cursorBefore: el.style.cursor,
      }
      el.style.cursor = 'grabbing'
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
      const dy = e.clientY - panning.startClientY
      if (dx === 0 && dy === 0) return
      scroller.scrollLeft = panning.startScrollLeft - dx
      scroller.scrollTop = panning.startScrollTop - dy
    }

    const endPan = (e: PointerEvent): void => {
      if (!panning || e.pointerId !== panning.pointerId) return
      const cursorBefore = panning.cursorBefore
      try {
        el.releasePointerCapture(e.pointerId)
      } catch {
        // no-op
      }
      if (cursorBefore !== undefined) el.style.cursor = cursorBefore
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

    /**
     * Zoom the viewport to cover exactly `[startMs, endMs]`. Uses the same
     * imperative-widen-then-scroll dance as `applyZoom` so there's no
     * one-frame flicker when the zoom crosses the current scrollWidth.
     * Leaves the committed selection in place so the user can press `Z`
     * repeatedly without losing their anchor.
     */
    const zoomToRange = (startMs: number, endMs: number): void => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const span = Math.max(endMs - startMs, MIN_SPAN_MS)
      const traceSpan = Math.max(
        boundsRef.current.end - boundsRef.current.start,
        MIN_SPAN_MS,
      )
      const labelWidth = labelWidthRef.current
      const contentWidthPx = Math.max(0, scroller.clientWidth - labelWidth)
      if (contentWidthPx <= 0) return
      const targetPxPerMs = clampPxPerMs(
        contentWidthPx / span,
        traceSpan,
        fitPxPerMsRef.current,
      )
      // Place `startMs` at the left edge of the content area (not the
      // left edge of the inner surface). The sticky label gutter
      // covers inner-x `[scrollLeft, scrollLeft + labelWidth]`, so the
      // visible track content starts at inner-x `scrollLeft +
      // labelWidth`. Since the inner-x of `startMs` is `labelWidth +
      // (startMs - start) * pxPerMs`, solving for scrollLeft gives
      // `(startMs - start) * pxPerMs` — the labelWidth terms cancel.
      // Including `labelWidth +` here (as a previous iteration did)
      // shifted the zoomed view one full gutter width to the right.
      const targetScrollLeft =
        (startMs - boundsRef.current.start) * targetPxPerMs

      pxPerMsRef.current = targetPxPerMs
      const nextInnerWidthPx = labelWidth + traceSpan * targetPxPerMs
      const surfaceEl = el as HTMLElement
      if (
        surfaceEl.style.width === '' ||
        parseFloat(surfaceEl.style.width) < nextInnerWidthPx
      ) {
        surfaceEl.style.width = `${nextInnerWidthPx}px`
      }
      scroller.scrollLeft = targetScrollLeft
      setPxPerMsOverride(targetPxPerMs)
      storeRef.current.set({
        pxPerMs: targetPxPerMs,
        scrollLeft: targetScrollLeft,
      })
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      // Z / Shift+Z and Escape are handled even under some modifier sets
      // that `shouldHandleKey` would otherwise gate out — specifically,
      // Z zoom-to-selection is allowed with Shift (to clear).
      if (e.key === 'Escape') {
        const sel = selectionStoreRef.current
        if (sel && (sel.get().committed || sel.get().inProgress)) {
          e.preventDefault()
          sel.clear()
          return
        }
      }
      if ((e.key === 'z' || e.key === 'Z') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const sel = selectionStoreRef.current
        const active = document.activeElement as HTMLElement | null
        const inField =
          !!active &&
          (active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.tagName === 'SELECT' ||
            active.isContentEditable)
        if (inField) return
        if (e.shiftKey) {
          if (sel) {
            e.preventDefault()
            sel.clear()
          }
          return
        }
        const committed = sel?.get().committed
        if (committed && committed.endMs > committed.startMs) {
          e.preventDefault()
          zoomToRange(committed.startMs, committed.endMs)
          return
        }
        // No selection → fall through; Z has no other binding.
        return
      }
      if (!shouldHandleKey(e)) return
      switch (e.key) {
        case 'w':
        case 'W':
          e.preventDefault()
          applyZoom(
            -KEY_ZOOM_DELTA_Y * KEYBOARD_NAV_SCALE,
            resolveZoomAnchor(),
          )
          break
        case 's':
        case 'S':
          e.preventDefault()
          applyZoom(KEY_ZOOM_DELTA_Y * KEYBOARD_NAV_SCALE, resolveZoomAnchor())
          break
        case 'a':
        case 'A': {
          const scroller = scrollerRef.current
          if (!scroller) return
          e.preventDefault()
          const step =
            KEYBOARD_NAV_SCALE *
            Math.max(
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
          const step =
            KEYBOARD_NAV_SCALE *
            Math.max(
              KEY_PAN_MIN_PX,
              scroller.clientWidth * KEY_PAN_VIEWPORT_FRACTION,
            )
          keyboardPan(step)
          break
        }
      }
    }

    // `auxclick` fires on middle (and right) button release. On Linux
    // Chrome this triggers "paste from primary selection" — we want our
    // middle-click-drag to feel like a pan, not paste random text into
    // focused inputs, so we swallow the event when the button is 1.
    // Note: pointerdown already called preventDefault, but browsers
    // still dispatch auxclick unless we also cancel it here.
    const onAuxClick = (e: MouseEvent): void => {
      if (e.button === 1) e.preventDefault()
    }

    el.addEventListener('wheel', onWheel, {passive: false})
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointermove', onPointerMoveTrack)
    el.addEventListener('pointerleave', onPointerLeaveTrack)
    el.addEventListener('pointerup', endPan)
    el.addEventListener('pointercancel', endPan)
    el.addEventListener('auxclick', onAuxClick)
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
      el.removeEventListener('auxclick', onAuxClick)
      el.removeEventListener('gesturestart', onGesture as EventListener)
      el.removeEventListener('gesturechange', onGesture as EventListener)
      el.removeEventListener('gestureend', onGesture as EventListener)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [eventEl, scrollerRef])

  return {pxPerMs, eventTargetRef}
}
