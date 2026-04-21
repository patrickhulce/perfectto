import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {System, Timeline as TimelineModel, Track as TrackModel} from '../core'
import {buildOverviewUtilization} from '../core/render/overviewUtilization'
import TimelineSystem from './TimelineSystem'
import {useTimelineZoom} from './timeline/useTimelineViewport'
import {useTimelineHover, type HoverTrackLayout} from './timeline/useTimelineHover'
import {useTimelineSelection} from './timeline/useTimelineSelection'
import {containerDepth, ROW_HEIGHT} from './timeline/trackLayout'
import {createViewportStore} from './timeline/viewportStore'
import {createSelectionStore, type SelectionStore} from './timeline/selectionStore'
import TimelineAxis, {TIMELINE_AXIS_HEIGHT_PX} from './timeline/TimelineAxis'
import TimelineOverview, {TIMELINE_OVERVIEW_HEIGHT_PX} from './timeline/TimelineOverview'
import SelectionOverlay from './timeline/SelectionOverlay'

interface TimelineProps {
  timeline: TimelineModel
  selectionStore?: SelectionStore
}

export interface PerfecttoTimelineSnapshot {
  readonly pxPerMs: number
  readonly scrollLeft: number
  readonly scrollTop: number
  readonly innerWidthPx: number
  readonly labelWidthPx: number
  readonly timelineStart: number
  readonly timelineEnd: number
  readonly scrollerRect: {x: number; y: number; width: number; height: number} | null
}

declare global {
  interface Window {
    __perfecttoTimeline?: PerfecttoTimelineSnapshot
  }
}

export const LABEL_WIDTH_PX = 192
const SYSTEM_HEADER_HEIGHT_PX = 37
const SYSTEM_BORDER_HEIGHT_PX = 1
const TRACK_BORDER_HEIGHT_PX = 1
const MIN_SPAN_MS = 0.01
/**
 * Floor for any track's vertical footprint. Keeps the two-line label
 * (name + category) from being clipped on shallow tracks, independent of
 * how many rows of content the track actually has.
 */
const MIN_TRACK_HEIGHT_PX = 44

export interface SystemLayout {
  system: System
  topPx: number
  heightPx: number
  headerHeightPx: number
  expanded: boolean
  tracks: TrackLayout[]
}

export interface TrackLayout {
  track: TrackModel
  topPx: number
  heightPx: number
  expanded: boolean
}

function trackHeightPx(track: TrackModel, expanded: boolean): number {
  // When collapsed we only render depth 0 (one row of direct children).
  const depth = expanded ? Math.max(containerDepth(track), 1) : 1
  return Math.max(depth * ROW_HEIGHT + 8 + TRACK_BORDER_HEIGHT_PX, MIN_TRACK_HEIGHT_PX)
}

function systemHeightPx(
  system: System,
  systemExpanded: boolean,
  trackExpanded: Record<string, boolean>,
): number {
  const header = SYSTEM_HEADER_HEIGHT_PX + SYSTEM_BORDER_HEIGHT_PX
  if (!systemExpanded) return header
  let tracksHeight = 0
  for (const track of system.tracks) {
    const expanded = trackExpanded[track.id] ?? true
    tracksHeight += trackHeightPx(track, expanded)
  }
  return header + tracksHeight
}

export default function Timeline({timeline, selectionStore}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Single floating tooltip element shared by all tracks. Lives in the
  // outer scroller (not inside any TimelineSystem) so it can be positioned
  // in viewport coordinates without escaping the row's stacking context.
  const tooltipRef = useRef<HTMLDivElement | null>(null)

  // The viewport store is the single source of truth for pxPerMs /
  // scrollLeft / viewport dimensions that canvases need. It's created once
  // per Timeline mount and fed by the zoom hook + scroll listener. Canvases
  // subscribe directly and redraw via rAF — no React render per frame.
  const storeRef = useRef<ReturnType<typeof createViewportStore> | null>(null)
  if (storeRef.current === null) {
    storeRef.current = createViewportStore({
      pxPerMs: 0,
      scrollLeft: 0,
      scrollTop: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      labelWidthPx: LABEL_WIDTH_PX,
      timelineStart: timeline.start,
      timelineEnd: timeline.end,
    })
  }
  const store = storeRef.current

  // Selection store. Mirrors the viewport-store pattern — one instance per
  // Timeline mount, created lazily on first render. When a parent passes
  // in their own `selectionStore` we use that instead so the Aggregator
  // panel (mounted as a sibling, not a descendant) can read the same
  // state without threading props through React.
  const localSelectionStoreRef = useRef<SelectionStore | null>(null)
  if (localSelectionStoreRef.current === null && !selectionStore) {
    localSelectionStoreRef.current = createSelectionStore()
  }
  const effectiveSelectionStore =
    selectionStore ?? (localSelectionStoreRef.current as SelectionStore)

  // React-visible mirrors of a handful of store fields. Kept narrow so that
  // only layout-relevant changes (viewport size for fit-zoom math, vertical
  // scroll for row virtualization) force React renders. `scrollLeft` and
  // `pxPerMs` are intentionally NOT mirrored — those change every zoom tick
  // and canvases get them from the store directly.
  const [viewportWidth, setViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)

  const [systemExpanded, setSystemExpanded] = useState<Record<string, boolean>>({})
  const toggleSystem = useCallback((id: string) => {
    setSystemExpanded(prev => ({...prev, [id]: prev[id] === undefined ? false : !prev[id]}))
  }, [])

  const [trackExpanded, setTrackExpanded] = useState<Record<string, boolean>>({})
  const toggleTrack = useCallback((id: string) => {
    setTrackExpanded(prev => ({...prev, [id]: prev[id] === undefined ? false : !prev[id]}))
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const updateSize = (): void => {
      const w = el.clientWidth
      const h = el.clientHeight
      setViewportWidth(w)
      setViewportHeight(h)
      store.set({viewportWidth: w, viewportHeight: h})
    }
    updateSize()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(updateSize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [store])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf: number | null = null
    // Two update paths:
    //  - store.set fires immediately on every scroll event so canvases see
    //    the new scrollLeft on the very next rAF (no one-frame lag).
    //  - React setScrollTop is rAF-throttled because it only drives row
    //    virtualization, which doesn't need sub-frame resolution.
    const onScroll = (): void => {
      // Echo suppression: browsers round `scroller.scrollLeft = X` to the
      // nearest integer pixel on write. When `useTimelineZoom.applyZoom`
      // writes a sub-pixel target (e.g. 49.31) the browser stores 49 and
      // fires a `scroll` event with the rounded value. If we just
      // overwrote the store with that, we'd permanently lose the 0.31px
      // sub-pixel component on every zoom tick — over a 20-tick burst
      // the error compounds into > 10px of visible anchor drift.
      //
      // Fix: if the DOM's rounded scrollLeft is within 1px of the store's
      // current (precise) value, assume this is our own echo and keep
      // the precise value. Native user pans (wheel, drag on scrollbar,
      // keyboard) always move by ≥ 1px so real pan events still
      // propagate.
      const domScrollLeft = el.scrollLeft
      const storedScrollLeft = store.get().scrollLeft
      if (Math.abs(domScrollLeft - storedScrollLeft) < 1) {
        store.set({scrollTop: el.scrollTop})
      } else {
        store.set({scrollLeft: domScrollLeft, scrollTop: el.scrollTop})
      }
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        setScrollTop(el.scrollTop)
      })
    }
    onScroll()
    el.addEventListener('scroll', onScroll, {passive: true})
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [store])

  const {pxPerMs, eventTargetRef} = useTimelineZoom({
    bounds: {start: timeline.start, end: timeline.end},
    labelWidthPx: LABEL_WIDTH_PX,
    containerWidthPx: viewportWidth,
    scrollerRef: scrollRef,
    store,
    selectionStore: effectiveSelectionStore,
  })

  // Precompute vertical layout with current expanded state. We reserve
  // `TIMELINE_OVERVIEW_HEIGHT_PX + TIMELINE_AXIS_HEIGHT_PX` at the top
  // for the sticky overview track and the sticky time ruler so the
  // first TimelineSystem starts just below them (systems are absolutely
  // positioned within the event surface by their `topPx`).
  const layout = useMemo(() => {
    const items: SystemLayout[] = []
    let y = TIMELINE_OVERVIEW_HEIGHT_PX + TIMELINE_AXIS_HEIGHT_PX
    for (const system of timeline.systems) {
      const expanded = systemExpanded[system.id] ?? true
      const headerHeightPx = SYSTEM_HEADER_HEIGHT_PX + SYSTEM_BORDER_HEIGHT_PX
      const tracksStartY = y + headerHeightPx
      const tracks: TrackLayout[] = []
      if (expanded) {
        let ty = tracksStartY
        for (const track of system.tracks) {
          const trackIsExpanded = trackExpanded[track.id] ?? true
          const h = trackHeightPx(track, trackIsExpanded)
          tracks.push({track, topPx: ty, heightPx: h, expanded: trackIsExpanded})
          ty += h
        }
      }
      const heightPx = systemHeightPx(system, expanded, trackExpanded)
      items.push({system, topPx: y, heightPx, headerHeightPx, expanded, tracks})
      y += heightPx
    }
    return {items, totalHeightPx: y}
  }, [timeline.systems, systemExpanded, trackExpanded])

  const totalSpanMs = Math.max(timeline.end - timeline.start, MIN_SPAN_MS)
  const innerWidthPx = LABEL_WIDTH_PX + totalSpanMs * pxPerMs

  // Overview utilization. Computed once per `timeline` identity — the
  // parser hands us a fresh object per trace, so memoizing on it is
  // equivalent to "compute on parse". Runs on the main thread; O(total
  // depth-0 slices) plus a 7-tap smoothing pass, well inside a frame.
  const overviewUtilization = useMemo(
    () => buildOverviewUtilization(timeline),
    [timeline],
  )

  // Test hook: expose a live snapshot of the viewport state so e2e tests can
  // verify zoom anchoring and cursor math without scraping the DOM. Reads
  // from refs/DOM each access so it always reflects the current state. No-op
  // outside the browser.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const labelWidthPx = LABEL_WIDTH_PX
    const timelineStart = timeline.start
    const timelineEnd = timeline.end
    const snapshot: PerfecttoTimelineSnapshot = {
      get pxPerMs() {
        return store.get().pxPerMs
      },
      get scrollLeft() {
        // Prefer the store's precise value over `scrollRef.current.
        // scrollLeft`: applyZoom writes a sub-pixel float that the DOM
        // rounds to the nearest integer, and the scroll-listener's echo
        // suppression keeps the precise value alive in the store. Tests
        // and anchor math need the precise value to avoid compounding
        // rounding errors across zoom ticks.
        return store.get().scrollLeft
      },
      get scrollTop() {
        return scrollRef.current?.scrollTop ?? 0
      },
      get innerWidthPx() {
        return innerWidthPx
      },
      get labelWidthPx() {
        return labelWidthPx
      },
      get timelineStart() {
        return timelineStart
      },
      get timelineEnd() {
        return timelineEnd
      },
      get scrollerRect() {
        const el = scrollRef.current
        if (!el) return null
        const r = el.getBoundingClientRect()
        return {x: r.x, y: r.y, width: r.width, height: r.height}
      },
    }
    window.__perfecttoTimeline = snapshot
    return () => {
      if (window.__perfecttoTimeline === snapshot) {
        delete window.__perfecttoTimeline
      }
    }
  }, [innerWidthPx, timeline.start, timeline.end, store])

  // Coarse vertical row virtualization: only mount system/track wrappers
  // that are at least partially visible. Horizontal culling lives inside
  // each CanvasTrackRenderer since it reads scrollLeft straight from the
  // store.
  const verticalOverscanPx = Math.max(200, viewportHeight * 0.5)
  const visibleTop = scrollTop - verticalOverscanPx
  const visibleBottom = scrollTop + viewportHeight + verticalOverscanPx

  const visibleSystems = useMemo(() => {
    return layout.items.filter(
      item => item.topPx < visibleBottom && item.topPx + item.heightPx > visibleTop,
    )
  }, [layout.items, visibleTop, visibleBottom])

  // Flatten currently-mounted tracks into the row-list shape useTimelineHover
  // wants. We pass the full vertical layout (not just `visibleSystems`) so
  // that fast cursor moves during overscroll still hit-test correctly.
  const hoverTrackRows = useMemo<HoverTrackLayout[]>(() => {
    const rows: HoverTrackLayout[] = []
    for (const sys of layout.items) {
      if (!sys.expanded) continue
      for (const tl of sys.tracks) {
        rows.push({
          track: tl.track,
          topPx: tl.topPx,
          heightPx: tl.heightPx,
          expanded: tl.expanded,
        })
      }
    }
    return rows
  }, [layout.items])

  const eventTargetElRef = useRef<HTMLElement | null>(null)
  const setEventTarget = useCallback((el: HTMLElement | null) => {
    eventTargetElRef.current = el
    eventTargetRef(el)
  }, [eventTargetRef])

  useTimelineHover({
    scrollerRef: scrollRef,
    eventTargetRef: eventTargetElRef,
    store,
    trackRows: hoverTrackRows,
    tooltipRef,
    selectionStore: effectiveSelectionStore,
  })

  // Separate ref for the overview canvas so the selection hook can wire
  // a dedicated left-drag handler there (distinct from the main event
  // surface) — allows future differentiation like "overview drag always
  // selects, even over the label gutter" if we want it.
  const overviewCanvasRef = useRef<HTMLCanvasElement | null>(null)

  useTimelineSelection({
    scrollerRef: scrollRef,
    eventTargetRef: eventTargetElRef,
    overviewCanvasRef,
    store,
    selectionStore: effectiveSelectionStore,
    tooltipRef,
  })

  return (
    <div
      ref={scrollRef}
      className="relative min-h-0 flex-1 overflow-auto"
      // Reserve scrollbar-gutter space in both axes at all times so
      // zooming across the fit threshold doesn't reflow anything:
      //  - `scrollbarGutter: 'stable'` reserves the vertical (inline)
      //    gutter — only reliable axis the spec covers.
      //  - `overflowX: 'scroll'` forces the horizontal scrollbar to
      //    always be present (even at fit-zoom where there's nothing
      //    to scroll), which is the only way to prevent the ~15px
      //    vertical reflow the CSS spec doesn't give us a gutter
      //    property for. Matches Chrome DevTools' Performance panel.
      style={{scrollbarGutter: 'stable', overflowX: 'scroll'}}
    >
      <div
        ref={setEventTarget}
        data-testid="timeline-event-surface"
        className="relative"
        style={{width: innerWidthPx, height: layout.totalHeightPx}}
      >
        <TimelineOverview
          overview={overviewUtilization}
          store={store}
          selectionStore={effectiveSelectionStore}
          labelWidthPx={LABEL_WIDTH_PX}
          canvasRef={overviewCanvasRef}
        />
        <TimelineAxis
          store={store}
          labelWidthPx={LABEL_WIDTH_PX}
          stickyTopPx={TIMELINE_OVERVIEW_HEIGHT_PX}
        />
        {visibleSystems.map(item => (
          <TimelineSystem
            key={item.system.id}
            layout={item}
            labelWidthPx={LABEL_WIDTH_PX}
            viewportTopPx={visibleTop}
            viewportBottomPx={visibleBottom}
            store={store}
            onToggle={() => toggleSystem(item.system.id)}
            onToggleTrack={toggleTrack}
          />
        ))}
        <SelectionOverlay
          store={store}
          selectionStore={effectiveSelectionStore}
          labelWidthPx={LABEL_WIDTH_PX}
          totalHeightPx={layout.totalHeightPx}
        />
      </div>
      {/*
        Floating tooltip. `position: fixed` keeps it pinned in viewport
        coordinates regardless of scroll, and `pointer-events: none` so
        cursor tracking through it never re-fires hit tests. The hover
        hook mutates `textContent` and `style.transform` directly — no
        React renders per mousemove.
      */}
      <div
        ref={tooltipRef}
        data-testid="timeline-tooltip"
        role="tooltip"
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-50 max-w-xs whitespace-nowrap rounded border border-[#2d3748] bg-[#0b0f17]/95 px-2 py-1 text-xs text-[#e2e8f0] shadow-lg transition-opacity duration-75"
        style={{opacity: 0, transform: 'translate(0px, 0px)'}}
      />
    </div>
  )
}
