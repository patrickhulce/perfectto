import {useCallback, useEffect, useRef, useState, type RefObject} from 'react'
import {flushSync} from 'react-dom'

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
  /**
   * Invoked synchronously inside the same `flushSync` that updates
   * `pxPerMs` on a zoom commit, with the new scrollLeft the hook is about
   * to write to the DOM. Use this to keep React-side `scrollLeft` state in
   * sync so viewport culling (visible ms/systems) uses the post-zoom value
   * on the first rendered frame — otherwise the render runs with old
   * scrollLeft + new pxPerMs and you get one frame of misaligned culling.
   */
  onCommitScrollLeft?: (scrollLeft: number) => void
}

export interface EffectiveZoom {
  /** `desiredPxPerMs / committedPxPerMs`. 1 when no gesture is active. */
  scale: number
  /** CSS `translateX` (px) applied to each track's content layer. */
  translatePx: number
}

export interface UseTimelineZoomResult {
  pxPerMs: number
  /** Attach to the element that should receive wheel + pointer gestures. */
  eventTargetRef: (el: HTMLElement | null) => void
  /**
   * Read the current effective scale/translate. Updated synchronously on
   * every rAF tick during an active zoom gesture. Safe to call at any time
   * (returns `{scale: 1, translatePx: 0}` when idle).
   */
  getEffectiveZoom: () => EffectiveZoom
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
 * Idle time (ms) before a live zoom gesture is committed to React state.
 * While the timer hasn't fired we keep the compositor-only transform in place
 * so pinches and wheel bursts feel instant.
 */
const ZOOM_COMMIT_IDLE_MS = 250
/**
 * Effective deltaY equivalent per W/S keypress. Matched to a single wheel
 * notch (~100) so keyboard and trackpad zoom feel identical, and held-key
 * auto-repeat composes smoothly through the same pendingScale path.
 */
const KEY_ZOOM_DELTA_Y = 80
/**
 * Pan step per A/D keypress, expressed as a fraction of the scroller width.
 * Floored at `KEY_PAN_MIN_PX` so tiny viewports still move meaningfully.
 */
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

export function useTimelineZoom(
  options: UseTimelineZoomOptions,
): UseTimelineZoomResult {
  const {bounds, labelWidthPx, containerWidthPx, scrollerRef} = options

  // `onCommitScrollLeft` is stashed in a ref so changing its identity
  // between renders doesn't tear down the wheel/pointer listeners.
  const onCommitScrollLeftRef = useRef(options.onCommitScrollLeft)
  onCommitScrollLeftRef.current = options.onCommitScrollLeft

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

  // Refs that track the latest "committed" values — these are what React
  // rendered on the last pass. The zoom handler reads them to compute the
  // effective transform without needing to re-create the effect on every
  // render.
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

  // Live transform state. These live outside React so wheel ticks can update
  // them at compositor speed without scheduling a render.
  const effectiveScaleRef = useRef(1)
  const effectiveTranslateRef = useRef(0)

  const getEffectiveZoom = useCallback((): EffectiveZoom => {
    return {
      scale: effectiveScaleRef.current,
      translatePx: effectiveTranslateRef.current,
    }
  }, [])

  useEffect(() => {
    const el = eventEl
    if (!el) return

    // --- Mutable gesture state, scoped to this eventEl lifetime. -----------
    let pendingScale = 1
    let lastCursorClientX = 0
    /**
     * Tracks whether `lastCursorClientX` points somewhere over the timeline
     * surface. Used so WASD zoom anchors at the cursor when the user is
     * hovering the timeline, but falls back to the viewport center for
     * pure-keyboard interactions (or when the cursor has drifted away).
     */
    let cursorOverTimeline = false
    let rafHandle: number | null = null
    let idleTimer: ReturnType<typeof setTimeout> | null = null

    const writeVars = (scale: number, translatePx: number): void => {
      effectiveScaleRef.current = scale
      effectiveTranslateRef.current = translatePx
      el.style.setProperty('--zoom-scale', String(scale))
      el.style.setProperty('--zoom-translate', `${translatePx}px`)
      // Text counter-scale: applied to glyph-bearing spans inside the
      // transformed shape layer so letters stay at their natural pixel size
      // while the bar underneath stretches. Kept in sync with --zoom-scale
      // so it's always exactly the reciprocal.
      el.style.setProperty(
        '--zoom-inv-scale',
        scale !== 0 ? String(1 / scale) : '1',
      )
    }

    /**
     * Commit the live transform to React state atomically — the whole
     * rewrite must land in a single browser paint, otherwise the user sees
     * one frame of "old pxPerMs + no transform + new scrollLeft", which
     * reads as a jarring jump-back followed by a snap-forward.
     *
     * Sequence (all inside a single task, so the browser paints once):
     *   1. Compute `targetPxPerMs` and `targetScrollLeft` from the current
     *      transform + anchor so the committed state is pixel-equivalent to
     *      what the user is seeing right now.
     *   2. Clear the CSS vars (imperative) — the scale state is now "live"
     *      in React's `pxPerMs` update that's about to run.
     *   3. `flushSync(setPxPerMsOverride)` — React synchronously re-renders
     *      with the new `pxPerMs`, updating `innerWidthPx` on the inner
     *      surface and every MeasureView's position. No paint yet: we're
     *      still inside the same task.
     *   4. Set `scroller.scrollLeft = targetScrollLeft`. The new
     *      `innerWidthPx` (applied in step 3) gives us the scroll range we
     *      need so the browser doesn't clamp.
     *   5. Task ends; browser paints the final zoomed frame directly.
     */
    const commit = (): void => {
      if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle)
        rafHandle = null
      }
      const scroller = scrollerRef.current
      if (!scroller) return
      const scale = effectiveScaleRef.current
      if (scale === 1 && effectiveTranslateRef.current === 0) return

      const committed = pxPerMsRef.current
      const targetPxPerMs = clampPxPerMs(
        committed * scale,
        Math.max(boundsRef.current.end - boundsRef.current.start, MIN_SPAN_MS),
      )
      // The scale we actually get to keep may differ from the requested one
      // if we hit the clamp; re-derive it so translate + scrollLeft below
      // agree with the committed value.
      const realizedScale = committed > 0 ? targetPxPerMs / committed : 1

      const labelWidth = labelWidthRef.current
      const rect = scroller.getBoundingClientRect()
      const cursorXInViewport = Math.max(
        0,
        Math.min(lastCursorClientX - rect.left, scroller.clientWidth),
      )
      // `anchorLayerX` = x (in the committed content layer) currently showing
      // directly under the cursor, accounting for the live transform.
      const scrollLeft = scroller.scrollLeft
      const translate = effectiveTranslateRef.current
      const anchorLayerX =
        scale !== 0
          ? (scrollLeft + cursorXInViewport - labelWidth - translate) / scale
          : scrollLeft + cursorXInViewport - labelWidth

      const targetScrollLeft =
        labelWidth + anchorLayerX * realizedScale - cursorXInViewport

      // Step 2: clear the transform. Measures are still at old pxPerMs at
      // this instant — that inconsistency only exists inside this task,
      // which doesn't paint.
      writeVars(1, 0)
      pendingScale = 1

      // Step 3: force React to apply the new pxPerMs AND the new scrollLeft
      // synchronously in the same render — so viewport culling
      // (visibleStartMs/EndMs) uses the post-commit scrollLeft on the very
      // first frame, rather than lagging a frame behind the DOM.
      flushSync(() => {
        setPxPerMsOverride(targetPxPerMs)
        onCommitScrollLeftRef.current?.(targetScrollLeft)
      })

      // Step 4: align the DOM scroll position with the React state we just
      // committed. `innerWidthPx` has already been written by React's
      // commit above, so scrollLeft is not clamped. Browser paints once
      // the task ends.
      scroller.scrollLeft = targetScrollLeft
    }

    const flushRaf = (): void => {
      rafHandle = null
      if (pendingScale === 1) return
      const scroller = scrollerRef.current
      if (!scroller) return

      const span = Math.max(
        boundsRef.current.end - boundsRef.current.start,
        MIN_SPAN_MS,
      )
      const committed = pxPerMsRef.current
      // Derive the absolute upper/lower bound for the effective scale so
      // `committed * scale` still lands inside `clampPxPerMs`.
      const clampedTarget = clampPxPerMs(
        committed * effectiveScaleRef.current * pendingScale,
        span,
      )
      const newScale = committed > 0 ? clampedTarget / committed : 1
      pendingScale = 1
      if (newScale === effectiveScaleRef.current) return

      const labelWidth = labelWidthRef.current
      const rect = scroller.getBoundingClientRect()
      const cursorXInViewport = Math.max(
        0,
        Math.min(lastCursorClientX - rect.left, scroller.clientWidth),
      )
      // Reconstruct the anchor in committed coords from the CURRENT
      // (pre-update) transform so consecutive ticks stay anchored even after
      // earlier ticks changed effectiveScale.
      const prevScale = effectiveScaleRef.current
      const prevTranslate = effectiveTranslateRef.current
      const scrollLeft = scroller.scrollLeft
      const anchorLayerX =
        prevScale !== 0
          ? (scrollLeft + cursorXInViewport - labelWidth - prevTranslate) /
            prevScale
          : scrollLeft + cursorXInViewport - labelWidth

      // Keep the anchor nailed to the cursor under the new scale.
      // viewportX = (labelWidth - scrollLeft) + translate + scale * anchorLayerX
      //           = cursorXInViewport
      const newTranslate =
        cursorXInViewport - labelWidth + scrollLeft - newScale * anchorLayerX
      writeVars(newScale, newTranslate)
    }

    const scheduleRaf = (): void => {
      if (rafHandle !== null) return
      rafHandle = requestAnimationFrame(flushRaf)
    }

    const resetIdleTimer = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(commit, ZOOM_COMMIT_IDLE_MS)
    }

    /**
     * Queue a zoom tick using the same accumulator wheel input feeds. Used
     * by both ctrl+wheel and the W/S keyboard shortcuts so every zoom code
     * path shares the same rAF coalescing + debounced commit behavior.
     */
    const queueZoomTick = (deltaY: number, cursorClientX: number): void => {
      lastCursorClientX = cursorClientX
      pendingScale *= Math.exp(-deltaY * 0.0015)
      scheduleRaf()
      resetIdleTimer()
    }

    const onWheel = (e: WheelEvent): void => {
      const scroller = scrollerRef.current
      if (!scroller) return
      const zooming = e.ctrlKey || e.metaKey
      if (!zooming) {
        // Non-zoom wheel means the user is panning. If a zoom transform is
        // still active we must commit first so scrollLeft + pxPerMs agree
        // with what's on screen; otherwise native pan will fight the
        // artificial translate.
        if (
          effectiveScaleRef.current !== 1 ||
          effectiveTranslateRef.current !== 0
        ) {
          lastCursorClientX = e.clientX
          commit()
        }
        return // native scroll handles pan in both axes
      }
      e.preventDefault()
      queueZoomTick(e.deltaY, e.clientX)
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
      // Commit any pending zoom transform BEFORE starting a pan; otherwise
      // the pan's `startScrollLeft` would be out of sync with the visible
      // pixels.
      if (
        effectiveScaleRef.current !== 1 ||
        effectiveTranslateRef.current !== 0
      ) {
        lastCursorClientX = e.clientX
        commit()
      }
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

    // Track the cursor so WASD zoom can anchor at it. Updated even when no
    // gesture is active; cheap because mousemove isn't hot-path work.
    const onPointerMoveTrack = (e: PointerEvent): void => {
      lastCursorClientX = e.clientX
      cursorOverTimeline = true
    }
    const onPointerLeaveTrack = (): void => {
      cursorOverTimeline = false
    }

    /**
     * Ignore keydown when the user is typing in an input / textarea /
     * contenteditable, or when any modifier (ctrl/meta/alt) is held so we
     * don't hijack platform shortcuts like Cmd+W or Ctrl+A.
     */
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
      // viewport so W/S feel like "zoom around the middle of what I'm
      // looking at" rather than around a stale mouse position.
      return rect.left + rect.width / 2
    }

    const keyboardPan = (deltaPx: number): void => {
      const scroller = scrollerRef.current
      if (!scroller) return
      // Commit any live zoom before panning so the DOM scrollLeft actually
      // matches what the user sees (same rule as pointerdown / non-zoom
      // wheel).
      if (
        effectiveScaleRef.current !== 1 ||
        effectiveTranslateRef.current !== 0
      ) {
        // Anchor the commit at wherever the cursor currently is so we don't
        // yank content when the user transitions from mouse zoom to
        // keyboard pan.
        commit()
      }
      scroller.scrollLeft += deltaPx
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!shouldHandleKey(e)) return
      switch (e.key) {
        case 'w':
        case 'W':
          e.preventDefault()
          queueZoomTick(-KEY_ZOOM_DELTA_Y, resolveZoomAnchor())
          break
        case 's':
        case 'S':
          e.preventDefault()
          queueZoomTick(KEY_ZOOM_DELTA_Y, resolveZoomAnchor())
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
    // Keyboard listener is window-scoped so WASD works regardless of DOM
    // focus (the scroll container isn't tabbable by default). shouldHandleKey
    // above still suppresses it while typing into form controls.
    window.addEventListener('keydown', onKeyDown)

    return () => {
      if (rafHandle !== null) cancelAnimationFrame(rafHandle)
      if (idleTimer !== null) clearTimeout(idleTimer)
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

  return {pxPerMs, eventTargetRef, getEffectiveZoom}
}
