import {memo, useEffect, useRef} from 'react'
import type {SelectionStoreLike} from './selectionStore'
import type {ViewportStore} from './viewportStore'

interface SelectionOverlayProps {
  store: ViewportStore
  selectionStore: SelectionStoreLike
  labelWidthPx: number
  /**
   * Total height of the scroll content surface, so the overlay spans
   * every track underneath the overview/axis. Pure CSS height — the
   * inner event surface already sets `height: layout.totalHeightPx` and
   * we mirror that so vertical scroll moves the overlay with the tracks.
   */
  totalHeightPx: number
}

/**
 * Translucent shaded rectangle layered over the main timeline event
 * surface to show the user's current selection.
 *
 * Imperative-update pattern, same philosophy as the canvas renderers:
 *  - A single absolutely-positioned `<div>` child, sized/offset in CSS
 *    pixels via `style.left` / `style.width`.
 *  - Subscribes to the viewport store and selection store, schedules an
 *    rAF to recompute its layout when either changes.
 *  - React renders exactly once per mount; every subsequent update is
 *    `element.style.*` mutations — no tree reconciliation, no per-frame
 *    state writes.
 *
 * The overlay lives inside the event surface (above tracks, below the
 * sticky overview/axis via `z-index`) so pointer events fall through to
 * the canvases underneath — we explicitly set `pointer-events: none`.
 */
function SelectionOverlayBase({
  store,
  selectionStore,
  labelWidthPx,
  totalHeightPx,
}: SelectionOverlayProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return

    const render = (): void => {
      rafRef.current = null
      const vp = store.get()
      const sel = selectionStore.get()
      const range = sel.inProgress ?? sel.committed
      if (!range || range.endMs <= range.startMs || vp.pxPerMs <= 0) {
        box.style.opacity = '0'
        return
      }
      // Layer coordinates: inner surface starts at x=0 and the first
      // `labelWidthPx` CSS pixels are the sticky label gutter. A timeline
      // ms `t` sits at layerX = labelWidthPx + (t - timelineStart) * pxPerMs.
      const leftX =
        labelWidthPx + (range.startMs - vp.timelineStart) * vp.pxPerMs
      const rightX =
        labelWidthPx + (range.endMs - vp.timelineStart) * vp.pxPerMs
      const widthX = Math.max(1, rightX - leftX)

      // Always show — the overlay is inside the inner surface, so
      // horizontal scroll carries it along naturally. If the selection
      // is off-screen the browser just clips it.
      box.style.opacity = '1'
      box.style.left = `${leftX}px`
      box.style.width = `${widthX}px`
      box.style.height = `${totalHeightPx}px`
    }

    const schedule = (): void => {
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(render)
    }

    schedule()
    const unsubscribeViewport = store.subscribe(() => schedule())
    const unsubscribeSelection = selectionStore.subscribe(() => schedule())

    return () => {
      unsubscribeViewport()
      unsubscribeSelection()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [store, selectionStore, labelWidthPx, totalHeightPx])

  return (
    <div
      ref={rootRef}
      data-testid="timeline-selection-overlay"
      aria-hidden
      className="pointer-events-none"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: totalHeightPx,
        // Below the sticky overview (z=3) and axis (z=2) so they paint
        // on top; above tracks (no z-index) so the shade is visible.
        zIndex: 1,
      }}
    >
      <div
        ref={boxRef}
        className="pointer-events-none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 0,
          height: 0,
          opacity: 0,
          background: 'rgba(246, 224, 94, 0.08)',
          boxShadow:
            'inset 1px 0 0 rgba(246, 224, 94, 0.9), inset -1px 0 0 rgba(246, 224, 94, 0.9)',
          transition: 'opacity 60ms linear',
        }}
      />
    </div>
  )
}

export default memo(SelectionOverlayBase)
