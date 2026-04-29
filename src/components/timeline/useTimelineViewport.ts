import {useEffect, useRef, useState, type RefObject} from 'react'
import {ViewportStore} from './viewportStore'
import type {SelectionStoreLike} from './selectionStore'
import type {InputBindingsStore} from './inputBindingsStore'
import type {HoveredPaneStore} from './hoveredPaneStore'
import {
  matchGesture,
  modsFromEvent,
  normalizeKey,
  type Action,
  type Modifier,
} from './inputBindings'
import {classifyWheel, createCtrlTracker} from './trackpadDetect'

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
  selectionStore?: SelectionStoreLike
  /**
   * Input-binding store that drives which gesture triggers which
   * action. Optional so tests (and any future minimal usage) can fall
   * back to the historical hardcoded behavior.
   */
  bindingsStore?: InputBindingsStore
  /**
   * Hovered-pane store. When provided alongside a `paneId`, the
   * window-level keydown handler only dispatches when the cursor is
   * actually inside *this* pane's scroller. In multi-trace comparison
   * view that's how `Z`, `Esc`, `W/S/A/D` etc. avoid firing on every
   * pane simultaneously. When omitted, the handler runs unconditionally
   * (legacy single-pane behavior).
   */
  hoveredPaneStore?: HoveredPaneStore
  /**
   * Owning pane id, paired with `hoveredPaneStore`. Required for the
   * hover-gating to do anything; optional otherwise.
   */
  paneId?: string
}

export interface UseTimelineZoomResult {
  pxPerMs: number
  /** Attach to the element that should receive wheel + pointer gestures. */
  eventTargetRef: (el: HTMLElement | null) => void
  /**
   * Imperative handle to zoom the viewport to a time range. Populated
   * by the hook once it has mounted its event surface and cleared to
   * `null` on unmount. Callers should null-check before invoking.
   *
   * Exposed primarily for one-shot deep-link URL handling (see
   * `urlParams.ts`); every interactive zoom path inside the hook
   * continues to call the local closure directly.
   */
  zoomToRangeRef: RefObject<((startMs: number, endMs: number) => void) | null>
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
  const {
    bounds,
    labelWidthPx,
    containerWidthPx,
    scrollerRef,
    store,
    selectionStore,
    bindingsStore,
    hoveredPaneStore,
    paneId,
  } = options

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
  const bindingsStoreRef = useRef(bindingsStore)
  bindingsStoreRef.current = bindingsStore
  const hoveredPaneStoreRef = useRef(hoveredPaneStore)
  hoveredPaneStoreRef.current = hoveredPaneStore
  const paneIdRef = useRef(paneId)
  paneIdRef.current = paneId

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

  // Imperative handle for `zoomToRange`. Populated inside the main
  // effect below once the event element has mounted; consumers
  // (Timeline's URL-deep-link effect) read `.current` lazily so they
  // naturally no-op before the hook is ready.
  const zoomToRangeRef = useRef<((startMs: number, endMs: number) => void) | null>(null)

  useEffect(() => {
    const el = eventEl
    if (!el) return

    let lastCursorClientX = 0
    let cursorOverTimeline = false

    // Real-Ctrl tracker for classifying pinch-vs-ctrl+wheel. See
    // `trackpadDetect.ts` for the rationale — browsers synthesise
    // `ctrlKey=true` on wheel events during a pinch gesture.
    const ctrlTracker = createCtrlTracker()

    /**
     * Resolve the action bound to a non-key gesture with the given
     * modifiers. Returns `'none'` when there's no binding or no
     * bindings store is provided (so tests still work without a store).
     */
    const resolveAction = (
      kind: 'wheel' | 'leftDrag' | 'middleDrag' | 'click',
      mods: readonly Modifier[],
    ): Action => {
      const bs = bindingsStoreRef.current
      if (!bs) {
        // Back-compat fallback: emulate the historical hardcoded
        // behavior so tests that don't pass a bindings store still see
        // the old model (ctrl/cmd+wheel zooms, middle-drag pans).
        if (kind === 'wheel' && (mods.includes('ctrl') || mods.includes('cmd'))) {
          return 'viewport.scrollZoom'
        }
        if (kind === 'middleDrag' && mods.length === 0) return 'viewport.panBoth'
        return 'none'
      }
      return matchGesture(kind, mods, bs.get().bindings)
    }

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

    const WHEEL_NUDGE_STEP_PX = 60

    const onWheel = (e: WheelEvent): void => {
      const scroller = scrollerRef.current
      if (!scroller) return

      // Trackpad gestures bypass the binding matrix: a two-finger
      // swipe must always scroll and a pinch must always zoom,
      // regardless of what `wheel` is bound to. Only a physical mouse
      // wheel is routed through the matrix.
      const kind = classifyWheel(e, ctrlTracker.isCtrlDown())
      if (kind === 'trackpad-pinch') {
        e.preventDefault()
        applyZoom(e.deltaY, e.clientX)
        return
      }
      if (kind === 'trackpad-scroll') {
        // Let the native scroller handle both axes — don't
        // preventDefault. The matrix only covers `wheel`, not trackpad
        // two-finger scrolls.
        return
      }

      const mods = modsFromEvent(e)
      const action = resolveAction('wheel', mods)
      // Choose the dominant axis so sideways-scroll mice still feel
      // right when the binding expects vertical delta.
      const dominantDelta =
        Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      switch (action) {
        case 'viewport.scrollZoom':
          e.preventDefault()
          applyZoom(dominantDelta, e.clientX)
          return
        case 'viewport.scrollHorizontal':
        case 'viewport.panHorizontal':
          e.preventDefault()
          scroller.scrollLeft += dominantDelta
          return
        case 'viewport.scrollVertical':
        case 'viewport.panVertical':
          // Native scroll on the outer scroller handles vertical pan
          // already. Returning without preventDefault lets the
          // browser do its job (including inertial scroll on Mac).
          return
        case 'viewport.nudgeIn':
          e.preventDefault()
          applyZoom(-KEY_ZOOM_DELTA_Y, e.clientX)
          return
        case 'viewport.nudgeOut':
          e.preventDefault()
          applyZoom(KEY_ZOOM_DELTA_Y, e.clientX)
          return
        case 'viewport.nudgeLeft':
          e.preventDefault()
          scroller.scrollLeft -= WHEEL_NUDGE_STEP_PX
          return
        case 'viewport.nudgeRight':
          e.preventDefault()
          scroller.scrollLeft += WHEEL_NUDGE_STEP_PX
          return
        default:
          // 'none' or selection actions — nothing sensible to do with
          // a wheel. Let the default scroll happen.
          return
      }
    }

    /**
     * Safari trackpad pinch dispatches `gesturestart`/`gesturechange`/
     * `gestureend` instead of synthetic ctrl+wheel. We always zoom
     * regardless of preset (same rule as trackpad-pinch on Chrome),
     * anchored at the gesture's reported coordinates. Without the
     * `preventDefault` the browser page-zooms.
     */
    let gestureStartScale = 1
    let gestureStartClientX = 0
    const onGestureStart = (e: Event): void => {
      e.preventDefault()
      const ge = e as Event & {scale?: number; clientX?: number}
      gestureStartScale = ge.scale ?? 1
      gestureStartClientX = ge.clientX ?? 0
    }
    const onGestureChange = (e: Event): void => {
      e.preventDefault()
      const ge = e as Event & {scale?: number; clientX?: number}
      const scale = ge.scale ?? 1
      if (scale === gestureStartScale || scale <= 0) return
      // Convert Safari's multiplicative scale into the additive
      // deltaY our `applyZoom` expects (which uses
      // `Math.exp(-deltaY * 0.0015)` internally). Solving for deltaY
      // at the ratio gives a smooth, pinch-proportional zoom.
      const ratio = scale / gestureStartScale
      const deltaY = -Math.log(ratio) / 0.0015
      gestureStartScale = scale
      const anchorX = ge.clientX ?? gestureStartClientX
      applyZoom(deltaY, anchorX)
    }
    const onGestureEnd = (e: Event): void => {
      e.preventDefault()
      gestureStartScale = 1
    }

    /**
     * Active pointer gesture tracked by this hook. Covers:
     *  - `pan-*`: a drag that moves scrollLeft/scrollTop.
     *  - `click-track`: a left-click that hasn't crossed the 3px
     *    threshold yet. If pointerup fires before the threshold, we
     *    dispatch whatever the `click` gesture is bound to.
     */
    type PanAxes = 'x' | 'y' | 'both'
    let panning:
      | {
          kind: 'pan'
          axes: PanAxes
          pointerId: number
          startClientX: number
          startClientY: number
          startScrollLeft: number
          startScrollTop: number
          button: number
          /** Inline `cursor` before pan; restore on release. */
          cursorBefore?: string
        }
      | {
          // Left-button pressed over the timeline, but we haven't decided
          // whether this is a pan or a click yet. Promotes to `pan` once
          // movement crosses `CLICK_THRESHOLD_PX`; a release before then
          // flows through the same click-dispatch path as `click-track`.
          // This is what lets single-click slice-selection keep working
          // on presets where `leftDrag` is bound to pan — without it,
          // pan starts on the initial `pointerdown` and consumes the
          // pointerup, so the selection hook's click tracker never sees
          // a clean click.
          kind: 'pending-pan'
          axes: PanAxes
          pointerId: number
          startClientX: number
          startClientY: number
          startScrollLeft: number
          startScrollTop: number
          button: number
          cursorBefore?: string
        }
      | {
          kind: 'click-track'
          pointerId: number
          startClientX: number
          startClientY: number
        }
      | null = null

    const CLICK_THRESHOLD_PX = 3

    const panAxesForAction = (action: Action): PanAxes | null => {
      switch (action) {
        case 'viewport.panBoth':
          return 'both'
        case 'viewport.panHorizontal':
          return 'x'
        case 'viewport.panVertical':
          return 'y'
        default:
          return null
      }
    }

    /**
     * Actions that make sense to dispatch on a discrete click event
     * (viewport-owned subset). Selection-side click actions (`deselect`)
     * are handled in `useTimelineSelection` since that hook owns the
     * committed-range state the deselect decision depends on.
     */
    const dispatchClickAction = (action: Action, clientX: number): void => {
      switch (action) {
        case 'viewport.scrollZoom':
        case 'viewport.nudgeIn':
          applyZoom(-KEY_ZOOM_DELTA_Y, clientX)
          return
        case 'viewport.nudgeOut':
          applyZoom(KEY_ZOOM_DELTA_Y, clientX)
          return
        case 'selection.zoomToSelection': {
          const sel = selectionStoreRef.current
          const committed = sel?.get().committed
          if (committed && committed.endMs > committed.startMs) {
            zoomToRange(committed.startMs, committed.endMs)
          }
          return
        }
        case 'selection.clearSelection': {
          const sel = selectionStoreRef.current
          sel?.clear()
          return
        }
        default:
          // `selection.deselect` and other selection actions belong to
          // the selection hook; leave them alone here.
          return
      }
    }

    const onPointerDown = (e: PointerEvent): void => {
      const scroller = scrollerRef.current
      if (!scroller) return

      const target = e.target as HTMLElement | null
      const overInteractive = !!target?.closest(
        'button, input, textarea, [data-no-pan]',
      )

      const mods = modsFromEvent(e)

      if (e.button === 1) {
        // Middle-click is conventionally "pan this surface" — it
        // bypasses the interactive-chrome filter so dragging from a
        // gutter toggle still pans. Left-click keeps the filter so
        // row-expand buttons still fire on plain clicks.
        // Middle-button: consult the `middleDrag` binding.
        const action = resolveAction('middleDrag', mods)
        const axes = panAxesForAction(action)
        if (axes === null) return
        // preventDefault on middle-click suppresses Chrome's classic
        // auto-scroll cursor (the four-arrow widget) so the drag
        // behaves like a regular pan.
        e.preventDefault()
        panning = {
          kind: 'pan',
          axes,
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
          // Non-capture-eligible target; ignore.
        }
        return
      }

      if (e.button === 0) {
        // Row-chrome toggles win over left-drag pans so the user can
        // still click the expand affordance — same contract the
        // selection hook applies for left-drag-to-select.
        if (overInteractive) return
        // Left-button: the selection hook owns this sequence when
        // `leftDrag` is bound to `selection.selectRange`. Otherwise
        // we handle it here as a pan or a click-track.
        const action = resolveAction('leftDrag', mods)
        if (action === 'selection.selectRange') return
        const axes = panAxesForAction(action)
        if (axes !== null) {
          // Enter pending-pan: we don't commit to a pan (cursor change,
          // pointer capture) until the pointer actually moves past
          // `CLICK_THRESHOLD_PX`. This preserves click-to-select on the
          // default preset where `leftDrag` is bound to pan.
          panning = {
            kind: 'pending-pan',
            axes,
            pointerId: e.pointerId,
            startClientX: e.clientX,
            startClientY: e.clientY,
            startScrollLeft: scroller.scrollLeft,
            startScrollTop: scroller.scrollTop,
            button: e.button,
            cursorBefore: el.style.cursor,
          }
          return
        }
        // `leftDrag` bound to none or to something we don't handle
        // (nudge-on-drag isn't meaningful). Track the pointer so we
        // can still dispatch the `click` binding on short releases.
        panning = {
          kind: 'click-track',
          pointerId: e.pointerId,
          startClientX: e.clientX,
          startClientY: e.clientY,
        }
        return
      }
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!panning || e.pointerId !== panning.pointerId) return
      if (panning.kind === 'click-track') {
        const dx = e.clientX - panning.startClientX
        const dy = e.clientY - panning.startClientY
        if (Math.abs(dx) >= CLICK_THRESHOLD_PX || Math.abs(dy) >= CLICK_THRESHOLD_PX) {
          // Abandon click tracking once the user crosses the drag
          // threshold. No drag action is bound, so we simply stop
          // caring about this pointer sequence.
          panning = null
        }
        return
      }
      if (panning.kind === 'pending-pan') {
        const dxPending = e.clientX - panning.startClientX
        const dyPending = e.clientY - panning.startClientY
        if (
          Math.abs(dxPending) < CLICK_THRESHOLD_PX &&
          Math.abs(dyPending) < CLICK_THRESHOLD_PX
        ) {
          // Still within the click slop — don't commit to a pan yet.
          return
        }
        // Threshold crossed: promote to a real pan. Change the cursor
        // and grab the pointer so subsequent move/up events route here
        // even if the pointer leaves the element's box.
        panning = {
          kind: 'pan',
          axes: panning.axes,
          pointerId: panning.pointerId,
          startClientX: panning.startClientX,
          startClientY: panning.startClientY,
          startScrollLeft: panning.startScrollLeft,
          startScrollTop: panning.startScrollTop,
          button: panning.button,
          cursorBefore: panning.cursorBefore,
        }
        el.style.cursor = 'grabbing'
        try {
          el.setPointerCapture(e.pointerId)
        } catch {
          // Non-capture-eligible target; ignore.
        }
        // Fall through to the scroll update below so the very first
        // past-threshold frame already moves the viewport.
      }
      const scroller = scrollerRef.current
      if (!scroller) return
      const dx = e.clientX - panning.startClientX
      const dy = e.clientY - panning.startClientY
      if (dx === 0 && dy === 0) return
      if (panning.axes === 'x' || panning.axes === 'both') {
        scroller.scrollLeft = panning.startScrollLeft - dx
      }
      if (panning.axes === 'y' || panning.axes === 'both') {
        scroller.scrollTop = panning.startScrollTop - dy
      }
    }

    const endPan = (e: PointerEvent): void => {
      if (!panning || e.pointerId !== panning.pointerId) return
      if (panning.kind === 'click-track' || panning.kind === 'pending-pan') {
        // Either we never bound a drag action (click-track) or we bound
        // one but the pointer never moved far enough to commit
        // (pending-pan). Either way, a sub-threshold release at this
        // point is a click — dispatch the `click` binding. A release
        // on `pointercancel` past threshold is a no-op, matching the
        // prior click-track behavior.
        const dx = e.clientX - panning.startClientX
        const dy = e.clientY - panning.startClientY
        const isClick =
          Math.abs(dx) < CLICK_THRESHOLD_PX && Math.abs(dy) < CLICK_THRESHOLD_PX
        panning = null
        if (!isClick) return
        const action = resolveAction('click', modsFromEvent(e))
        // `selection.deselect` is intentionally left to the selection
        // hook (it needs the anchor's ms to decide inside/outside the
        // committed range). Everything else dispatches here.
        if (action !== 'selection.deselect') {
          dispatchClickAction(action, e.clientX)
        }
        return
      }
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

    /**
     * Keyboard nudge step size in CSS pixels. Smaller than the
     * `KEYBOARD_NAV_SCALE`-boosted zoom step because A/D presses are
     * typically rapid-fire (users hold them down) and a 3x-scaled pan
     * overshoots the region under inspection on every tap.
     */
    const keyboardPanStep = (): number => {
      const scroller = scrollerRef.current
      if (!scroller) return KEY_PAN_MIN_PX
      return Math.max(
        KEY_PAN_MIN_PX,
        scroller.clientWidth * KEY_PAN_VIEWPORT_FRACTION,
      )
    }

    /**
     * Dispatch a bound action as a keyboard event — W/S nudge, A/D
     * pan, Z zoom-to-selection, Escape clear, etc. Returns whether
     * the caller should `preventDefault`.
     */
    const dispatchKeyAction = (action: Action): boolean => {
      switch (action) {
        case 'viewport.nudgeIn':
          applyZoom(-KEY_ZOOM_DELTA_Y * KEYBOARD_NAV_SCALE, resolveZoomAnchor())
          return true
        case 'viewport.nudgeOut':
          applyZoom(KEY_ZOOM_DELTA_Y * KEYBOARD_NAV_SCALE, resolveZoomAnchor())
          return true
        case 'viewport.nudgeLeft':
          keyboardPan(-keyboardPanStep())
          return true
        case 'viewport.nudgeRight':
          keyboardPan(keyboardPanStep())
          return true
        case 'viewport.scrollZoom':
          applyZoom(-KEY_ZOOM_DELTA_Y * KEYBOARD_NAV_SCALE, resolveZoomAnchor())
          return true
        case 'viewport.scrollHorizontal':
        case 'viewport.panHorizontal':
          keyboardPan(keyboardPanStep())
          return true
        case 'selection.zoomToSelection': {
          const sel = selectionStoreRef.current
          const committed = sel?.get().committed
          if (committed && committed.endMs > committed.startMs) {
            zoomToRange(committed.startMs, committed.endMs)
            return true
          }
          return false
        }
        case 'selection.clearSelection': {
          // Layered Esc: each press peels one layer so users can back
          // out of complex selections in the same order they built
          // them. Hovered slices are pointer-driven and don't
          // participate. If nothing is selected, return false so
          // other Esc consumers (e.g. SettingsPanel close) can run.
          const sel = selectionStoreRef.current
          if (!sel) return false
          const state = sel.get()
          if (state.inProgress) {
            sel.cancel()
            return true
          }
          if (state.committed) {
            sel.setCommitted(null)
            return true
          }
          if (state.selectedSlice) {
            sel.setSelectedSlice(null)
            return true
          }
          return false
        }
        default:
          return false
      }
    }

    /**
     * Key handler: consults the bindings matrix first, with a couple
     * of exceptions for inputs. Escape is always allowed through
     * `shouldHandleKey`-style input filtering because clearing the
     * selection is useful even when focus is elsewhere on the page.
     */
    const onKeyDown = (e: KeyboardEvent): void => {
      const bs = bindingsStoreRef.current
      if (!bs) return
      // Multi-trace gating: every Timeline mounts its own
      // window-level `keydown` listener, so without this check N panes
      // would each fire `Z` / `Esc` / pan keys on the same press. When
      // a `hoveredPaneStore` + `paneId` are both wired, this hook only
      // runs when the cursor is inside *its* scroller. Cursor over the
      // Aggregator (or off-page) → no pane responds, which beats
      // dispatching to an arbitrary pane. Single-pane mode (no
      // hoveredPaneStore) skips the gate entirely so behavior is
      // unchanged.
      const hps = hoveredPaneStoreRef.current
      const myPaneId = paneIdRef.current
      if (hps && myPaneId !== undefined && hps.get() !== myPaneId) return
      // Gate out typing in real inputs so rebinding 'w' to something
      // doesn't hijack every W keypress in the app.
      const active = document.activeElement as HTMLElement | null
      const inField =
        !!active &&
        (active.tagName === 'INPUT' ||
          active.tagName === 'TEXTAREA' ||
          active.tagName === 'SELECT' ||
          active.isContentEditable)
      if (inField) return

      const mods = modsFromEvent(e)
      const key = normalizeKey(e.key)
      const action = matchGesture('key', mods, bs.get().bindings, key)
      if (action === 'none') return
      const consumed = dispatchKeyAction(action)
      if (consumed) e.preventDefault()
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

    // Publish the imperative zoom handle now that the event surface
    // has mounted and the closure above has captured stable refs for
    // scroller / store / bounds.
    zoomToRangeRef.current = zoomToRange

    el.addEventListener('wheel', onWheel, {passive: false})
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointermove', onPointerMoveTrack)
    el.addEventListener('pointerleave', onPointerLeaveTrack)
    el.addEventListener('pointerup', endPan)
    el.addEventListener('pointercancel', endPan)
    el.addEventListener('auxclick', onAuxClick)
    el.addEventListener('gesturestart', onGestureStart as EventListener)
    el.addEventListener('gesturechange', onGestureChange as EventListener)
    el.addEventListener('gestureend', onGestureEnd as EventListener)
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
      el.removeEventListener('gesturestart', onGestureStart as EventListener)
      el.removeEventListener('gesturechange', onGestureChange as EventListener)
      el.removeEventListener('gestureend', onGestureEnd as EventListener)
      window.removeEventListener('keydown', onKeyDown)
      ctrlTracker.dispose()
      zoomToRangeRef.current = null
    }
  }, [eventEl, scrollerRef])

  return {pxPerMs, eventTargetRef, zoomToRangeRef}
}
