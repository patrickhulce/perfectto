import {useEffect, type RefObject} from 'react'
import type {Track as TrackModel} from '../../core'
import {hitTestTrack} from './hitTest'
import {ROW_HEIGHT} from './trackLayout'
import type {SelectionStore} from './selectionStore'
import type {ViewportStore} from './viewportStore'

/**
 * Minimum effective slice width, in pixels, for hit-testing. Slices
 * narrower than this are widened symmetrically in the time domain so
 * the cursor can still land on them. Sized slightly larger than the
 * canvas draw-path's `MIN_SLICE_WIDTH_PX` (≈ 1px) so users don't need
 * pixel-perfect aim on sub-millisecond slices.
 */
const MIN_HITBOX_PX = 3

export interface HoverTrackLayout {
  /** The track this row maps to. We hit-test against `track.buffers`. */
  track: TrackModel
  /** Top of the track's content area, in scroll-content y coordinates. */
  topPx: number
  /** Total drawn height of the row, in CSS pixels. */
  heightPx: number
  /** Same `expanded` flag the renderer uses to gate `maxDepthExclusive`. */
  expanded: boolean
}

export interface UseTimelineHoverOptions {
  /** The outer scroll container — its bounding rect maps client coords. */
  scrollerRef: RefObject<HTMLElement | null>
  /** The element that already receives wheel/pointer gestures. */
  eventTargetRef: RefObject<HTMLElement | null>
  /** Live viewport state (pxPerMs, scrollLeft, labelWidthPx, ...). */
  store: ViewportStore
  /**
   * Vertically-laid-out flat list of *track* rows currently mounted. The
   * Timeline already computes this for layout; we reuse it so hover doesn't
   * have to walk systems → tracks.
   */
  trackRows: HoverTrackLayout[]
  /**
   * The single floating tooltip element. We mutate its `textContent`,
   * `style.transform`, and `data-visible` directly — no React state per
   * mousemove.
   */
  tooltipRef: RefObject<HTMLElement | null>
  /**
   * Optional selection store. When a drag-selection is in progress the
   * hover tooltip suppresses itself so the selection's duration tooltip
   * (owned by `useTimelineSelection`) is the only one visible.
   */
  selectionStore?: SelectionStore
}

/**
 * Wires up a `pointermove`/`pointerleave`-driven tooltip.
 *
 * - Zero React renders per cursor move: we mutate the tooltip element
 *   imperatively using refs.
 * - Hit-test reads the *raw* `track.buffers` (not the mipmap), so even
 *   sub-pixel slices that visually merge into a density bucket can still be
 *   inspected on hover.
 * - Hides the tooltip during pointer captures (drag-pan) by listening for
 *   `pointerdown` / `pointerup` and gating updates accordingly.
 */
export function useTimelineHover(options: UseTimelineHoverOptions): void {
  const {scrollerRef, eventTargetRef, store, trackRows, tooltipRef, selectionStore} = options

  useEffect(() => {
    const eventEl = eventTargetRef.current
    const scroller = scrollerRef.current
    if (!eventEl || !scroller) return

    let panning = false
    let lastShown = false

    const hideTooltip = (): void => {
      const tip = tooltipRef.current
      if (!tip) return
      if (!lastShown) return
      tip.style.opacity = '0'
      tip.setAttribute('aria-hidden', 'true')
      lastShown = false
    }

    const showTooltip = (
      text: string,
      clientX: number,
      clientY: number,
    ): void => {
      const tip = tooltipRef.current
      if (!tip) return
      tip.textContent = text
      // 12px gap so the cursor never sits on top of the text. We don't try
      // to flip the tooltip when it would clip the right viewport edge —
      // simpler than getting the measured tooltip width per frame, and the
      // tooltip's `max-width` already keeps it from overflowing too far.
      tip.style.transform = `translate(${clientX + 12}px, ${clientY + 12}px)`
      if (!lastShown) {
        tip.style.opacity = '1'
        tip.setAttribute('aria-hidden', 'false')
        lastShown = true
      }
    }

    const onPointerDown = (): void => {
      panning = true
      hideTooltip()
    }
    const onPointerUp = (): void => {
      panning = false
    }

    const onPointerMove = (e: PointerEvent): void => {
      if (panning) {
        hideTooltip()
        return
      }
      // Suppress the hover tooltip during an active drag-selection so
      // the selection's duration readout is the only one visible.
      if (selectionStore && selectionStore.get().inProgress) {
        hideTooltip()
        return
      }
      const state = store.get()
      const pxPerMs = state.pxPerMs
      if (pxPerMs <= 0 || trackRows.length === 0) {
        hideTooltip()
        return
      }
      const rect = scroller.getBoundingClientRect()
      const relX = e.clientX - rect.left
      const relY = e.clientY - rect.top
      // Cursor is over the sticky label gutter, not the canvas content.
      // We don't tooltip the gutter itself; the `<button>` there has its
      // own focus/title affordance.
      if (relX < state.labelWidthPx) {
        hideTooltip()
        return
      }
      // Translate viewport-relative cursor into timeline ms. `scrollLeft`
      // already accounts for the label gutter inset (the inner surface
      // starts at x=0; the gutter sits inside the first labelWidthPx of
      // every row), so the formula matches what `useTimelineViewport`'s
      // applyZoom uses for anchor math.
      const layerX = state.scrollLeft + relX - state.labelWidthPx
      const timelineMs = state.timelineStart + layerX / pxPerMs

      // Vertical scroll has already been applied to the inner surface, so
      // the row layout (precomputed in scroll-content coordinates) needs
      // scrollTop added to the cursor y.
      const contentY = state.scrollTop + relY
      const row = findRowAt(trackRows, contentY)
      if (!row) {
        hideTooltip()
        return
      }

      const buffers = row.track.buffers
      if (!buffers || buffers.count === 0) {
        hideTooltip()
        return
      }
      const trackLocalY = contentY - row.topPx
      const maxDepthExclusive = row.expanded ? Number.POSITIVE_INFINITY : 1
      // Widen the hit-test to roughly MIN_HITBOX_PX pixels so 0.01ms
      // compositor / RunTask slices (rendered as a single-pixel bar)
      // are still hoverable. Kept slightly larger than the canvas
      // draw-path's `MIN_SLICE_WIDTH_PX` so the user doesn't need
      // pixel-perfect aim.
      const minHitboxMs = pxPerMs > 0 ? MIN_HITBOX_PX / pxPerMs : 0
      const hit = hitTestTrack(
        buffers,
        timelineMs,
        trackLocalY,
        ROW_HEIGHT,
        maxDepthExclusive,
        minHitboxMs,
      )
      if (hit.index < 0) {
        hideTooltip()
        return
      }
      const measure = buffers.measures[hit.index]
      if (!measure) {
        hideTooltip()
        return
      }
      showTooltip(
        formatTooltip(measure.name, measure.end - measure.start),
        e.clientX,
        e.clientY,
      )
    }

    const onPointerLeave = (): void => {
      hideTooltip()
    }

    eventEl.addEventListener('pointermove', onPointerMove)
    eventEl.addEventListener('pointerleave', onPointerLeave)
    eventEl.addEventListener('pointerdown', onPointerDown)
    eventEl.addEventListener('pointerup', onPointerUp)
    eventEl.addEventListener('pointercancel', onPointerUp)

    return () => {
      eventEl.removeEventListener('pointermove', onPointerMove)
      eventEl.removeEventListener('pointerleave', onPointerLeave)
      eventEl.removeEventListener('pointerdown', onPointerDown)
      eventEl.removeEventListener('pointerup', onPointerUp)
      eventEl.removeEventListener('pointercancel', onPointerUp)
      hideTooltip()
    }
  }, [eventTargetRef, scrollerRef, store, trackRows, tooltipRef, selectionStore])
}

/**
 * Linear scan over `trackRows`. We don't bother with binary search — even
 * "lots of tracks" is a few hundred rows, and pointermove fires at most one
 * per frame. A search would be a micro-optimization at the cost of an extra
 * sort guarantee on the input.
 */
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

function formatTooltip(name: string, durationMs: number): string {
  return `${name} · ${formatDuration(durationMs)}`
}

/** Compact ms → human duration matching how the rest of the UI talks about time. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms === 0) return '0 ms'
  if (ms < MS_PER_US * 1000) return `${(ms / MS_PER_US).toFixed(0)} µs`
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`
  if (ms < 10) return `${ms.toFixed(2)} ms`
  if (ms < 1000) return `${ms.toFixed(1)} ms`
  return `${(ms / MS_PER_S).toFixed(2)} s`
}

// Visible for tests.
export const __test__ = {findRowAt, formatDuration, formatTooltip}
