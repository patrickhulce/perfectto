import {useEffect, type RefObject} from 'react'
import type {SelectionStore} from './selectionStore'
import type {ViewportStore} from './viewportStore'
import type {InputBindingsStore} from './inputBindingsStore'
import {matchGesture, modsFromEvent} from './inputBindings'
import {hitTestTrack} from './hitTest'
import {ROW_HEIGHT} from './trackLayout'
import type {HoverTrackLayout} from './useTimelineHover'

export interface UseTimelineSelectionOptions {
  /** Outer scroll container — its bounding rect maps client coords. */
  scrollerRef: RefObject<HTMLElement | null>
  /** The main timeline event surface (same element `useTimelineZoom` binds to). */
  eventTargetRef: RefObject<HTMLElement | null>
  /** The overview canvas, where any left-drag also selects. */
  overviewCanvasRef: RefObject<HTMLCanvasElement | null>
  store: ViewportStore
  selectionStore: SelectionStore
  /**
   * Shared floating tooltip element. The hook shows a live duration
   * readout during drag by mutating `textContent` + `style.transform`,
   * matching the imperative pattern used by `useTimelineHover`.
   */
  tooltipRef: RefObject<HTMLElement | null>
  /**
   * Track-row layout (same list `useTimelineHover` consumes). Used to
   * hit-test a sub-threshold click on the main surface and promote it
   * to a slice-level selection so the tree-highlight affordance has
   * something sticky to latch onto after the cursor moves away.
   * Optional for the overview-only and test-only call sites.
   */
  trackRows?: HoverTrackLayout[]
  /**
   * Input-binding store. When provided, the main-surface left-drag
   * only starts a selection if the current binding for `leftDrag`
   * (with the active modifiers) resolves to `selection.selectRange`.
   * The overview-canvas drag always selects regardless, because that
   * canvas has no other affordance. Optional for test-only usage.
   */
  bindingsStore?: InputBindingsStore
}

/**
 * Same generous hit-box the hover hook uses. Kept in sync so a click
 * lands on exactly the slice the user's cursor visually indicated.
 */
const MIN_HITBOX_PX = 3

/** Minimum pointer movement (in CSS px) before a click promotes to a drag. */
const MIN_DRAG_PX = 3

/**
 * Left-drag to select a time range.
 *
 * Wired to two surfaces:
 *  - Overview canvas: any left-drag selects.
 *  - Main timeline event surface: any left-drag selects.
 *
 * Rules:
 *  - Only button 0 (primary) participates. Middle-click continues to pan
 *    via `useTimelineZoom`.
 *  - We ignore pointerdown on gutter buttons / inputs (same
 *    `closest('button, input, textarea, [data-no-pan]')` filter pan
 *    used) so expanding a track doesn't start a selection.
 *  - A sub-3px move does nothing: we never commit a degenerate range and
 *    we never clear an existing committed selection on incidental
 *    clicks. Stray clicks fall through to the hover/hit-test layer.
 *  - The hook writes into `selectionStore.inProgress` live during drag,
 *    then `commit()`s on pointerup. Pointercancel rolls back the
 *    in-progress range without clearing any previously committed range.
 */
export function useTimelineSelection(
  options: UseTimelineSelectionOptions,
): void {
  const {
    scrollerRef,
    eventTargetRef,
    overviewCanvasRef,
    store,
    selectionStore,
    tooltipRef,
    trackRows,
    bindingsStore,
  } = options

  useEffect(() => {
    const eventSurface = eventTargetRef.current
    const overviewCanvas = overviewCanvasRef.current
    const scroller = scrollerRef.current
    if (!scroller) return
    if (!eventSurface && !overviewCanvas) return

    interface Drag {
      /** Which element the pointerdown landed on; listeners attach there for capture. */
      host: HTMLElement
      pointerId: number
      /** Timeline ms at the anchor — where the mouse first went down. */
      anchorMs: number
      /** Viewport-left clientX at anchor — used to detect the 3px threshold. */
      startClientX: number
      startClientY: number
      /** `true` once we've crossed MIN_DRAG_PX and committed to selection mode. */
      promoted: boolean
      /** Source (affects coordinate conversion): overview vs main timeline. */
      source: 'overview' | 'main'
    }

    let drag: Drag | null = null
    let lastShownTooltip = false

    const hideTooltip = (): void => {
      const tip = tooltipRef.current
      if (!tip || !lastShownTooltip) return
      tip.style.opacity = '0'
      tip.setAttribute('aria-hidden', 'true')
      lastShownTooltip = false
    }

    const showTooltip = (text: string, clientX: number, clientY: number): void => {
      const tip = tooltipRef.current
      if (!tip) return
      tip.textContent = text
      tip.style.transform = `translate(${clientX + 12}px, ${clientY + 12}px)`
      if (!lastShownTooltip) {
        tip.style.opacity = '1'
        tip.setAttribute('aria-hidden', 'false')
        lastShownTooltip = true
      }
    }

    /** clientX → timeline ms, given the drag source. */
    const clientXToMs = (clientX: number, source: 'overview' | 'main'): number => {
      const state = store.get()
      if (source === 'overview') {
        // Overview spans the full trace across the content area.
        const canvas = overviewCanvasRef.current
        if (!canvas) return state.timelineStart
        const rect = canvas.getBoundingClientRect()
        if (rect.width <= 0) return state.timelineStart
        const x = Math.max(0, Math.min(rect.width, clientX - rect.left))
        const span = Math.max(1e-6, state.timelineEnd - state.timelineStart)
        return state.timelineStart + (x / rect.width) * span
      }
      // Main timeline: clientX → layerX (subtract label gutter) → ms via pxPerMs.
      const rect = scroller.getBoundingClientRect()
      const relX = clientX - rect.left
      const layerX = Math.max(0, state.scrollLeft + relX - state.labelWidthPx)
      if (state.pxPerMs <= 0) return state.timelineStart
      const ms = state.timelineStart + layerX / state.pxPerMs
      const clamped = Math.min(
        Math.max(ms, state.timelineStart),
        state.timelineEnd,
      )
      return clamped
    }

    const onPointerDown = (e: PointerEvent, source: 'overview' | 'main'): void => {
      if (e.button !== 0) return
      if (drag !== null) return
      const target = e.target as HTMLElement | null
      // For the main surface we want clicks on row toggle buttons to
      // keep working; the overview canvas has no such affordances.
      if (source === 'main' && target?.closest('button, input, textarea, [data-no-pan]')) {
        return
      }

      // Bindings gate on the main surface only. The overview canvas
      // always selects on left-drag regardless of preset — it has no
      // other affordance and rebinding it would be surprising.
      if (source === 'main' && bindingsStore) {
        const mods = modsFromEvent(e)
        const action = matchGesture('leftDrag', mods, bindingsStore.get().bindings)
        if (action !== 'selection.selectRange') {
          // Some other hook (or the viewport hook) owns this
          // gesture; leave the pointer alone.
          return
        }
      }

      const host = (source === 'overview' ? overviewCanvasRef.current : eventTargetRef.current) as HTMLElement | null
      if (!host) return

      // Stop the browser from starting a native text selection. CSS
      // `user-select: none` on the scroller already covers this in
      // evergreen browsers, but Safari / edge cases with contenteditable
      // ancestors still honor mousedown defaults. Calling
      // preventDefault after we've decided this pointerdown is ours
      // keeps click-through / capture semantics intact.
      e.preventDefault()

      // The overview canvas sits *inside* the main event surface in the
      // DOM, so a pointerdown on it bubbles up to where `useTimelineZoom`
      // is listening and would otherwise start a horizontal pan at the
      // same instant we're trying to draw a selection. Swallow the event
      // for the overview path only — the main-surface path still needs
      // to propagate to the viewport hook for middle-click pan etc.
      if (source === 'overview') {
        e.stopPropagation()
      }

      drag = {
        host,
        pointerId: e.pointerId,
        anchorMs: clientXToMs(e.clientX, source),
        startClientX: e.clientX,
        startClientY: e.clientY,
        promoted: false,
        source,
      }
      try {
        host.setPointerCapture(e.pointerId)
      } catch {
        // Capture may fail on non-elements; the drag still works via
        // the top-level window pointermove listener below.
      }
    }

    const updateInProgress = (currentClientX: number): void => {
      if (!drag) return
      const currentMs = clientXToMs(currentClientX, drag.source)
      const startMs = Math.min(drag.anchorMs, currentMs)
      const endMs = Math.max(drag.anchorMs, currentMs)
      selectionStore.setInProgress({anchorMs: drag.anchorMs, startMs, endMs})
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.pointerId) return
      // Overview-sourced drags must not leak to the viewport hook's
      // listeners on the event surface — same reason as the down path.
      if (drag.source === 'overview') e.stopPropagation()
      const dx = e.clientX - drag.startClientX
      const dy = e.clientY - drag.startClientY
      if (!drag.promoted) {
        if (Math.abs(dx) < MIN_DRAG_PX && Math.abs(dy) < MIN_DRAG_PX) return
        drag.promoted = true
      }
      updateInProgress(e.clientX)
      const ip = selectionStore.get().inProgress
      if (ip) {
        showTooltip(
          `Selection · ${formatDuration(ip.endMs - ip.startMs)}`,
          e.clientX,
          e.clientY,
        )
      }
    }

    const onPointerUp = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.pointerId) return
      if (drag.source === 'overview') e.stopPropagation()
      const host = drag.host
      const wasPromoted = drag.promoted
      try {
        host.releasePointerCapture(e.pointerId)
      } catch {
        // no-op
      }
      drag = null
      if (wasPromoted) {
        selectionStore.commit()
      } else {
        // Sub-threshold click via the range-drag path. The dedicated
        // click tracker below handles slice-select + click-action
        // dispatch uniformly for every preset (it's attached whether or
        // not `leftDrag` resolves to `selection.selectRange`), so this
        // branch only has to drop any in-progress range draft.
        selectionStore.cancel()
      }
      hideTooltip()
    }

    const onPointerCancel = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.pointerId) return
      if (drag.source === 'overview') e.stopPropagation()
      drag = null
      selectionStore.cancel()
      hideTooltip()
    }

    const onDownOverview = (e: PointerEvent): void => onPointerDown(e, 'overview')
    const onDownMain = (e: PointerEvent): void => onPointerDown(e, 'main')

    // --- Click tracker (main surface only) -------------------------------
    // Click-to-select-slice and click-away-to-deselect need to work on
    // EVERY preset, not just the ones that bind `leftDrag` to
    // `selection.selectRange`. The range-drag path above early-returns
    // on `onPointerDown` when the binding doesn't match (because the
    // viewport hook then owns the left-drag for panning), which would
    // otherwise silently break click-to-select on the default preset.
    //
    // This lightweight tracker records the pointerdown anchor without
    // calling `preventDefault()` or setting pointer capture, so it
    // never conflicts with the viewport hook's pan gesture or the
    // range-drag logic. On pointerup we check if movement stayed below
    // `MIN_DRAG_PX`; if so it's a click and we:
    //   1. Hit-test the slice under the cursor and write it into
    //      `selectionStore.selectedSlice` (or `null` for empty-space
    //      clicks, which clears any previous slice selection).
    //   2. If the `click` binding is `selection.deselect`, also clear
    //      the committed time range when the click landed outside it.
    //
    // Middle-click and right-click are ignored so scroll-wheel pans and
    // context menus still behave normally.
    interface ClickTracker {
      pointerId: number
      startClientX: number
      startClientY: number
    }
    let clickTracker: ClickTracker | null = null

    const onClickDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      // Row-chrome controls (expand buttons, track header inputs) must
      // keep their own click semantics; mirroring the same filter the
      // drag path uses keeps the two in sync.
      const target = e.target as HTMLElement | null
      if (target?.closest('button, input, textarea, [data-no-pan]')) return
      clickTracker = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
      }
    }

    const onClickMove = (e: PointerEvent): void => {
      if (!clickTracker || clickTracker.pointerId !== e.pointerId) return
      const dx = e.clientX - clickTracker.startClientX
      const dy = e.clientY - clickTracker.startClientY
      if (Math.abs(dx) >= MIN_DRAG_PX || Math.abs(dy) >= MIN_DRAG_PX) {
        // Crossed the drag threshold — this isn't a click anymore.
        clickTracker = null
      }
    }

    const onClickUp = (e: PointerEvent): void => {
      if (!clickTracker || clickTracker.pointerId !== e.pointerId) return
      const tracker = clickTracker
      clickTracker = null
      const dx = e.clientX - tracker.startClientX
      const dy = e.clientY - tracker.startClientY
      if (Math.abs(dx) >= MIN_DRAG_PX || Math.abs(dy) >= MIN_DRAG_PX) return
      const anchorMs = clientXToMs(e.clientX, 'main')
      if (trackRows && trackRows.length > 0) {
        const hit = hitTestSliceAtClick(
          trackRows,
          anchorMs,
          e.clientY,
          scroller,
          store,
        )
        selectionStore.setSelectedSlice(hit)
      }
      const clickAction = bindingsStore
        ? matchGesture('click', modsFromEvent(e), bindingsStore.get().bindings)
        : 'selection.deselect'
      if (clickAction === 'selection.deselect') {
        const committed = selectionStore.get().committed
        if (committed !== null) {
          const inside = anchorMs >= committed.startMs && anchorMs <= committed.endMs
          if (!inside) selectionStore.setCommitted(null)
        }
      } else if (clickAction === 'selection.clearSelection') {
        selectionStore.clear()
      }
    }

    const onClickCancel = (e: PointerEvent): void => {
      if (!clickTracker || clickTracker.pointerId !== e.pointerId) return
      clickTracker = null
    }

    overviewCanvas?.addEventListener('pointerdown', onDownOverview)
    eventSurface?.addEventListener('pointerdown', onDownMain)
    // Pointer capture routes moves/ups back to the host element. We
    // attach the listeners to *both* hosts so whichever drag is active
    // gets the events; the guard on `drag.pointerId` means the inactive
    // listener is a no-op.
    overviewCanvas?.addEventListener('pointermove', onPointerMove)
    overviewCanvas?.addEventListener('pointerup', onPointerUp)
    overviewCanvas?.addEventListener('pointercancel', onPointerCancel)
    eventSurface?.addEventListener('pointermove', onPointerMove)
    eventSurface?.addEventListener('pointerup', onPointerUp)
    eventSurface?.addEventListener('pointercancel', onPointerCancel)
    eventSurface?.addEventListener('pointerdown', onClickDown)
    eventSurface?.addEventListener('pointermove', onClickMove)
    eventSurface?.addEventListener('pointerup', onClickUp)
    eventSurface?.addEventListener('pointercancel', onClickCancel)

    return () => {
      overviewCanvas?.removeEventListener('pointerdown', onDownOverview)
      eventSurface?.removeEventListener('pointerdown', onDownMain)
      overviewCanvas?.removeEventListener('pointermove', onPointerMove)
      overviewCanvas?.removeEventListener('pointerup', onPointerUp)
      overviewCanvas?.removeEventListener('pointercancel', onPointerCancel)
      eventSurface?.removeEventListener('pointermove', onPointerMove)
      eventSurface?.removeEventListener('pointerup', onPointerUp)
      eventSurface?.removeEventListener('pointercancel', onPointerCancel)
      eventSurface?.removeEventListener('pointerdown', onClickDown)
      eventSurface?.removeEventListener('pointermove', onClickMove)
      eventSurface?.removeEventListener('pointerup', onClickUp)
      eventSurface?.removeEventListener('pointercancel', onClickCancel)
      hideTooltip()
    }
  }, [
    eventTargetRef,
    overviewCanvasRef,
    scrollerRef,
    store,
    selectionStore,
    tooltipRef,
    trackRows,
    bindingsStore,
  ])
}

/**
 * Resolve the slice under a click on the main event surface. Returns a
 * {@link SliceRef}-shaped object suitable for `selectionStore.setSelectedSlice`,
 * or `null` if the click missed the slice content entirely (over the
 * label gutter, empty row, outside any row, or on a sub-pixel gap).
 *
 * Mirrors the hit-test `useTimelineHover` runs on pointermove, including
 * the `MIN_HITBOX_PX` widening so sub-ms slices remain clickable.
 */
function hitTestSliceAtClick(
  rows: HoverTrackLayout[],
  timelineMs: number,
  clientY: number,
  scroller: HTMLElement,
  store: ViewportStore,
): import('./selectionStore').SliceRef | null {
  const rect = scroller.getBoundingClientRect()
  const state = store.get()
  if (state.pxPerMs <= 0) return null
  const contentY = state.scrollTop + (clientY - rect.top)
  const row = findRowAt(rows, contentY)
  if (!row) return null
  const buffers = row.track.buffers
  if (!buffers || buffers.count === 0) return null
  const trackLocalY = contentY - row.topPx
  const maxDepthExclusive = row.expanded ? Number.POSITIVE_INFINITY : 1
  const minHitboxMs = MIN_HITBOX_PX / state.pxPerMs
  const hit = hitTestTrack(
    buffers,
    timelineMs,
    trackLocalY,
    ROW_HEIGHT,
    maxDepthExclusive,
    minHitboxMs,
  )
  if (hit.index < 0) return null
  const measure = buffers.measures[hit.index]
  if (!measure) return null
  return {
    trackId: row.track.id,
    startMs: measure.start,
    endMs: measure.end,
    depth: hit.depth,
    measureId: measure.id,
  }
}

function findRowAt(
  rows: HoverTrackLayout[],
  contentY: number,
): HoverTrackLayout | null {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (contentY < r.topPx) continue
    if (contentY >= r.topPx + r.heightPx) continue
    return r
  }
  return null
}

const MS_PER_S = 1000
const MS_PER_US = 0.001

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms === 0) return '0 ms'
  if (ms < MS_PER_US * 1000) return `${(ms / MS_PER_US).toFixed(0)} µs`
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`
  if (ms < 10) return `${ms.toFixed(2)} ms`
  if (ms < 1000) return `${ms.toFixed(1)} ms`
  return `${(ms / MS_PER_S).toFixed(2)} s`
}

export const __test__ = {formatDuration, MIN_DRAG_PX, hitTestSliceAtClick}
