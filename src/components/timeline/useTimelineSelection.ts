import {useEffect, type RefObject} from 'react'
import type {SelectionStore} from './selectionStore'
import type {ViewportStore} from './viewportStore'
import type {InputBindingsStore} from './inputBindingsStore'
import {matchGesture, modsFromEvent} from './inputBindings'

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
   * Input-binding store. When provided, the main-surface left-drag
   * only starts a selection if the current binding for `leftDrag`
   * (with the active modifiers) resolves to `selection.selectRange`.
   * The overview-canvas drag always selects regardless, because that
   * canvas has no other affordance. Optional for test-only usage.
   */
  bindingsStore?: InputBindingsStore
}

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
      const host = drag.host
      const wasPromoted = drag.promoted
      const anchorMs = drag.anchorMs
      try {
        host.releasePointerCapture(e.pointerId)
      } catch {
        // no-op
      }
      drag = null
      if (wasPromoted) {
        selectionStore.commit()
      } else {
        // Sub-threshold click (no drag). Two things to do:
        //  1. Drop any in-progress draft so it doesn't linger.
        //  2. If the click landed outside an existing committed
        //     selection, clear the selection — the common "click away
        //     to deselect" gesture. Clicks inside the committed range
        //     are preserved so the user can still click through to
        //     inspect slices within their selection.
        //
        // The deselect step is gated on the `click` binding matching
        // `selection.deselect` so users who rebind click to something
        // else (or to `none`) don't lose their selection on incidental
        // clicks. All built-in presets keep this binding as deselect.
        selectionStore.cancel()
        const clickAction = bindingsStore
          ? matchGesture('click', modsFromEvent(e), bindingsStore.get().bindings)
          : 'selection.deselect'
        if (clickAction === 'selection.deselect') {
          const committed = selectionStore.get().committed
          if (committed !== null) {
            const inside = anchorMs >= committed.startMs && anchorMs <= committed.endMs
            if (!inside) {
              selectionStore.setCommitted(null)
            }
          }
        } else if (clickAction === 'selection.clearSelection') {
          selectionStore.clear()
        }
      }
      hideTooltip()
    }

    const onPointerCancel = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.pointerId) return
      drag = null
      selectionStore.cancel()
      hideTooltip()
    }

    const onDownOverview = (e: PointerEvent): void => onPointerDown(e, 'overview')
    const onDownMain = (e: PointerEvent): void => onPointerDown(e, 'main')

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

    return () => {
      overviewCanvas?.removeEventListener('pointerdown', onDownOverview)
      eventSurface?.removeEventListener('pointerdown', onDownMain)
      overviewCanvas?.removeEventListener('pointermove', onPointerMove)
      overviewCanvas?.removeEventListener('pointerup', onPointerUp)
      overviewCanvas?.removeEventListener('pointercancel', onPointerCancel)
      eventSurface?.removeEventListener('pointermove', onPointerMove)
      eventSurface?.removeEventListener('pointerup', onPointerUp)
      eventSurface?.removeEventListener('pointercancel', onPointerCancel)
      hideTooltip()
    }
  }, [
    eventTargetRef,
    overviewCanvasRef,
    scrollerRef,
    store,
    selectionStore,
    tooltipRef,
    bindingsStore,
  ])
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

export const __test__ = {formatDuration, MIN_DRAG_PX}
