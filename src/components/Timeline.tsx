import {useCallback, useDeferredValue, useEffect, useMemo, useRef, useState} from 'react'
import type {System, Timeline as TimelineModel, Track as TrackModel} from '../core'
import TimelineSystem from './TimelineSystem'
import {useTimelineZoom} from './timeline/useTimelineViewport'
import {containerDepth, ROW_HEIGHT} from './timeline/trackLayout'

interface TimelineProps {
  timeline: TimelineModel
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

  const {pxPerMs, eventTargetRef} = useTimelineZoom({
    bounds: {start: timeline.start, end: timeline.end},
    labelWidthPx: LABEL_WIDTH_PX,
    containerWidthPx: viewportWidth,
    scrollerRef: scrollRef,
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

  // Scroll + size inputs are deferred so the scroll event thread never blocks
  // on the expensive culling/measure-layout render. React 19 renders the new
  // culled output as a low-priority transition while translateX keeps the
  // already-mounted DOM moving at 60fps.
  const deferredScrollLeft = useDeferredValue(scrollLeft)
  const deferredScrollTop = useDeferredValue(scrollTop)
  const deferredViewportWidth = useDeferredValue(viewportWidth)
  const deferredViewportHeight = useDeferredValue(viewportHeight)

  const horizontalOverscanPx = Math.max(200, deferredViewportWidth * 0.5)
  const verticalOverscanPx = Math.max(200, deferredViewportHeight * 0.5)

  const visibleTop = deferredScrollTop - verticalOverscanPx
  const visibleBottom = deferredScrollTop + deferredViewportHeight + verticalOverscanPx

  const visibleStartMs = useMemo(() => {
    if (pxPerMs <= 0) return timeline.start
    const raw =
      timeline.start + (deferredScrollLeft - horizontalOverscanPx - LABEL_WIDTH_PX) / pxPerMs
    return Math.max(timeline.start, raw)
  }, [deferredScrollLeft, horizontalOverscanPx, pxPerMs, timeline.start])

  const visibleEndMs = useMemo(() => {
    if (pxPerMs <= 0) return timeline.end
    const raw =
      timeline.start +
      (deferredScrollLeft + deferredViewportWidth + horizontalOverscanPx - LABEL_WIDTH_PX) /
        pxPerMs
    return Math.min(timeline.end, raw)
  }, [
    deferredScrollLeft,
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
