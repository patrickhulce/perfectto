import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {System, Timeline as TimelineModel, Track as TrackModel} from '../core'
import TimelineSystem from './TimelineSystem'
import {useTimelineViewport, type Viewport} from './timeline/useTimelineViewport'
import {containerDepth, ROW_HEIGHT} from './timeline/trackLayout'

interface TimelineProps {
  timeline: TimelineModel
}

export const LABEL_WIDTH_PX = 192
const SYSTEM_HEADER_HEIGHT_PX = 37
const SYSTEM_BORDER_HEIGHT_PX = 1
const TRACK_BORDER_HEIGHT_PX = 1
const VERTICAL_OVERSCAN_PX = 200
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
  const trackRegionRef = useRef<HTMLDivElement | null>(null)

  const [trackRegionWidthPx, setTrackRegionWidthPx] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const [systemExpanded, setSystemExpanded] = useState<Record<string, boolean>>({})
  const toggleSystem = useCallback((id: string) => {
    setSystemExpanded(prev => ({...prev, [id]: prev[id] === undefined ? false : !prev[id]}))
  }, [])

  const [trackExpanded, setTrackExpanded] = useState<Record<string, boolean>>({})
  const toggleTrack = useCallback((id: string) => {
    setTrackExpanded(prev => ({...prev, [id]: prev[id] === undefined ? false : !prev[id]}))
  }, [])

  useEffect(() => {
    const el = trackRegionRef.current
    if (!el) return
    const update = () => setTrackRegionWidthPx(el.clientWidth)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = () => {
      setScrollTop(el.scrollTop)
      setViewportHeight(el.clientHeight)
    }
    update()
    el.addEventListener('scroll', update, {passive: true})
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(update)
      ro.observe(el)
      return () => {
        el.removeEventListener('scroll', update)
        ro.disconnect()
      }
    }
    return () => el.removeEventListener('scroll', update)
  }, [])

  const {viewport, eventTargetRef} = useTimelineViewport({
    bounds: {start: timeline.start, end: timeline.end},
    containerWidthPx: trackRegionWidthPx,
    labelOffsetPx: LABEL_WIDTH_PX,
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

  const visibleTop = scrollTop - VERTICAL_OVERSCAN_PX
  const visibleBottom = scrollTop + viewportHeight + VERTICAL_OVERSCAN_PX

  const visibleSystems = useMemo(() => {
    return layout.items.filter(
      item => item.topPx < visibleBottom && item.topPx + item.heightPx > visibleTop,
    )
  }, [layout.items, visibleTop, visibleBottom])

  return (
    <div ref={scrollRef} className="relative flex-1 overflow-auto">
      {/*
        Zoom + pan gestures are captured on this inner wrapper so they work
        anywhere over the timeline (including over measures and system
        headers). The label gutter offset is passed into the viewport hook
        so cursor-to-time math still anchors to the track region.
      */}
      <div
        ref={eventTargetRef}
        data-testid="timeline-event-surface"
        className="relative touch-none"
        style={{minWidth: '100%', height: layout.totalHeightPx}}
      >
        {/* Sizer row: fixed label column + flex track region the viewport measures. */}
        <div
          className="pointer-events-none absolute left-0 right-0 top-0 flex"
          style={{height: 0}}
          aria-hidden
        >
          <div style={{width: LABEL_WIDTH_PX, flex: '0 0 auto'}} />
          <div
            ref={trackRegionRef}
            style={{flex: '1 1 auto'}}
          />
        </div>

        {visibleSystems.map(item => (
          <TimelineSystem
            key={item.system.id}
            layout={item}
            viewport={viewport}
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

export type {Viewport}
