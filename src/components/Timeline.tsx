import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {System, Timeline as TimelineModel, Track as TrackModel} from '../core'
import TimelineSystem from './TimelineSystem'
import {useTimelineZoom} from './timeline/useTimelineViewport'
import {containerDepth, ROW_HEIGHT} from './timeline/trackLayout'
import {createViewportStore} from './timeline/viewportStore'

interface TimelineProps {
  timeline: TimelineModel
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

export default function Timeline({timeline}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

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
      store.set({scrollLeft: el.scrollLeft, scrollTop: el.scrollTop})
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
  })

  // Precompute vertical layout with current expanded state.
  const layout = useMemo(() => {
    const items: SystemLayout[] = []
    let y = 0
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
        return scrollRef.current?.scrollLeft ?? 0
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

  return (
    <div ref={scrollRef} className="relative flex-1 overflow-auto">
      <div
        ref={eventTargetRef}
        data-testid="timeline-event-surface"
        className="relative"
        style={{width: innerWidthPx, height: layout.totalHeightPx}}
      >
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
      </div>
    </div>
  )
}
