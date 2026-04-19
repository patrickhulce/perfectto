import {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react'
import type {System, Timeline as TimelineModel, Track as TrackModel} from '../core'
import TimelineSystem from './TimelineSystem'
import {useTimelineZoom} from './timeline/useTimelineViewport'
import {containerDepth, ROW_HEIGHT} from './timeline/trackLayout'

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
  readonly effectiveScale: number
  readonly effectiveTranslatePx: number
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

  const [viewportWidth, setViewportWidth] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scrollLeft, setScrollLeft] = useState(0)
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
    const updateSize = () => {
      setViewportWidth(el.clientWidth)
      setViewportHeight(el.clientHeight)
    }
    updateSize()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(updateSize)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf: number | null = null
    const onScroll = () => {
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        setScrollLeft(el.scrollLeft)
        setScrollTop(el.scrollTop)
      })
    }
    onScroll()
    el.addEventListener('scroll', onScroll, {passive: true})
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Handed to the zoom hook so it can keep React's `scrollLeft` state in
  // sync inside the same flushSync that updates `pxPerMs`. Without this,
  // the first render after a zoom commit would cull the viewport with
  // old scrollLeft + new pxPerMs and briefly drop measures on one side.
  const handleCommitScrollLeft = useCallback((nextScrollLeft: number) => {
    setScrollLeft(nextScrollLeft)
  }, [])

  const {pxPerMs, eventTargetRef, getEffectiveZoom} = useTimelineZoom({
    bounds: {start: timeline.start, end: timeline.end},
    labelWidthPx: LABEL_WIDTH_PX,
    containerWidthPx: viewportWidth,
    scrollerRef: scrollRef,
    onCommitScrollLeft: handleCommitScrollLeft,
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
  // from refs/DOM each access so it always reflects the current (possibly
  // mid-gesture) state. No-op outside the browser.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const labelWidthPx = LABEL_WIDTH_PX
    const timelineStart = timeline.start
    const timelineEnd = timeline.end
    const snapshot: PerfecttoTimelineSnapshot = {
      get pxPerMs() {
        return pxPerMs
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
      get effectiveScale() {
        return getEffectiveZoom().scale
      },
      get effectiveTranslatePx() {
        return getEffectiveZoom().translatePx
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
  }, [pxPerMs, innerWidthPx, timeline.start, timeline.end, getEffectiveZoom])

  // Vertical scroll + viewport size are deferred so window resizes / rapid
  // vertical scrolling don't block on the expensive culling render. React
  // renders the new culled output as a low-priority transition.
  //
  // scrollLeft is intentionally NOT deferred: horizontal scroll is already
  // rAF-throttled upstream, and deferring it creates a visible glitch at
  // zoom commit time — pxPerMs updates inside flushSync, but the deferred
  // scrollLeft still returns its old value for that urgent render, so
  // visibleStartMs/EndMs are computed with (oldScrollLeft, newPxPerMs) and
  // most measures are culled out of frame until React's transition render
  // catches up a beat later. That round-trip is the "big flash".
  const deferredScrollTop = useDeferredValue(scrollTop)
  const deferredViewportWidth = useDeferredValue(viewportWidth)
  const deferredViewportHeight = useDeferredValue(viewportHeight)

  const horizontalOverscanPx = Math.max(200, deferredViewportWidth * 0.5)
  const verticalOverscanPx = Math.max(200, deferredViewportHeight * 0.5)

  const visibleTop = deferredScrollTop - verticalOverscanPx
  const visibleBottom = deferredScrollTop + deferredViewportHeight + verticalOverscanPx

  const visibleStartMs = useMemo(() => {
    if (pxPerMs <= 0) return timeline.start
    const raw = timeline.start + (scrollLeft - horizontalOverscanPx - LABEL_WIDTH_PX) / pxPerMs
    return Math.max(timeline.start, raw)
  }, [scrollLeft, horizontalOverscanPx, pxPerMs, timeline.start])

  const visibleEndMs = useMemo(() => {
    if (pxPerMs <= 0) return timeline.end
    const raw =
      timeline.start +
      (scrollLeft + deferredViewportWidth + horizontalOverscanPx - LABEL_WIDTH_PX) / pxPerMs
    return Math.min(timeline.end, raw)
  }, [
    scrollLeft,
    deferredViewportWidth,
    horizontalOverscanPx,
    pxPerMs,
    timeline.start,
    timeline.end,
  ])

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
            timelineStartMs={timeline.start}
            pxPerMs={pxPerMs}
            labelWidthPx={LABEL_WIDTH_PX}
            visibleStartMs={visibleStartMs}
            visibleEndMs={visibleEndMs}
            viewportTopPx={visibleTop}
            viewportBottomPx={visibleBottom}
            onToggle={() => toggleSystem(item.system.id)}
            onToggleTrack={toggleTrack}
          />
        ))}
      </div>
    </div>
  )
}
