import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {AppliedPersona, System, Timeline as TimelineModel, Track as TrackModel} from '../core'
import {buildOverviewBands} from '../core/render/overviewBands'
import {buildOverviewUtilization} from '../core/render/overviewUtilization'
import TimelineSystem from './TimelineSystem'
import {useTimelineZoom} from './timeline/useTimelineViewport'
import {useTimelineHover, type HoverTrackLayout} from './timeline/useTimelineHover'
import {useTimelineSelection} from './timeline/useTimelineSelection'
import {containerDepth, ROW_HEIGHT} from './timeline/trackLayout'
import {createViewportStore} from './timeline/viewportStore'
import {createSelectionStore, type SelectionStore} from './timeline/selectionStore'
import type {InputBindingsStore} from './timeline/inputBindingsStore'
import TimelineAxis, {TIMELINE_AXIS_HEIGHT_PX} from './timeline/TimelineAxis'
import TimelineOverview, {TIMELINE_OVERVIEW_HEIGHT_PX} from './timeline/TimelineOverview'
import SelectionOverlay from './timeline/SelectionOverlay'

interface TimelineProps {
  timeline: TimelineModel
  selectionStore?: SelectionStore
  /**
   * Optional applied persona. When provided, systems/tracks are taken
   * from `appliedPersona.systems` (already filtered, sorted, relabeled),
   * initial expand state is seeded from the persona's defaults, hidden
   * tracks are exposed behind a per-system toggle, and the overview is
   * rendered as stacked category bands.
   */
  appliedPersona?: AppliedPersona
  /**
   * Input-bindings store. Drives which gesture triggers which action
   * (scroll/zoom/pan/select/…). Optional so tests and standalone
   * Timeline usage can fall back to the historical default behavior.
   */
  bindingsStore?: InputBindingsStore
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
/**
 * Height reserved below the last system for the "N hidden systems"
 * reveal button. Only allocated when the applied persona actually has
 * hidden systems; otherwise the footer collapses to 0 and totalHeightPx
 * matches the old layout exactly.
 */
const HIDDEN_SYSTEMS_FOOTER_HEIGHT_PX = 32

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
  /**
   * True iff the track has nested measures worth revealing. Tracks with only
   * top-level measures (`containerDepth === 1`) render identically whether
   * expanded or not, so we suppress the expand affordance entirely for them.
   */
  canExpand: boolean
}

function trackHeightPx(track: TrackModel, expanded: boolean): number {
  // When collapsed we only render depth 0 (one row of direct children).
  const depth = expanded ? Math.max(containerDepth(track), 1) : 1
  return Math.max(depth * ROW_HEIGHT + 8 + TRACK_BORDER_HEIGHT_PX, MIN_TRACK_HEIGHT_PX)
}

function computeSystemHeightPx(
  system: System,
  systemExpanded: boolean,
  trackExpanded: Record<string, boolean>,
  defaultTrackExpandedFromPersona: Record<string, boolean>,
): number {
  const header = SYSTEM_HEADER_HEIGHT_PX + SYSTEM_BORDER_HEIGHT_PX
  if (!systemExpanded) return header
  let tracksHeight = 0
  for (const track of system.tracks) {
    const trDefault = defaultTrackExpandedFromPersona[track.id] ?? true
    const expanded = trackExpanded[track.id] ?? trDefault
    tracksHeight += trackHeightPx(track, expanded)
  }
  return header + tracksHeight
}

export default function Timeline({
  timeline,
  selectionStore,
  appliedPersona,
  bindingsStore,
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Single floating tooltip element shared by all tracks. Lives in the
  // outer scroller (not inside any TimelineSystem) so it can be positioned
  // in viewport coordinates without escaping the row's stacking context.
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  // Hover-highlight outline. Mutated imperatively by `useTimelineHover`
  // (zero React renders per cursor move), drawn over the hovered slice
  // so you can see which rect the tooltip is describing — border-only
  // variant, no canvas repaint, no re-render of other tracks.
  const hoverHighlightRef = useRef<HTMLDivElement | null>(null)

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

  // Persona-supplied defaults. A track or system that has a default here
  // starts in that state; users can still toggle it freely afterwards.
  const defaultSystemExpandedFromPersona =
    appliedPersona?.defaultSystemExpanded ?? {}
  const defaultTrackExpandedFromPersona =
    appliedPersona?.defaultTrackExpanded ?? {}

  const [systemExpanded, setSystemExpanded] = useState<Record<string, boolean>>({})
  const toggleSystem = useCallback((id: string) => {
    const personaDefault = defaultSystemExpandedFromPersona[id]
    const uiDefault = personaDefault ?? true
    setSystemExpanded(prev => ({
      ...prev,
      [id]: prev[id] === undefined ? !uiDefault : !prev[id],
    }))
  }, [defaultSystemExpandedFromPersona])

  const [trackExpanded, setTrackExpanded] = useState<Record<string, boolean>>({})
  const toggleTrack = useCallback(
    (id: string) => {
      const personaDefault = defaultTrackExpandedFromPersona[id]
      const uiDefault = personaDefault ?? true
      setTrackExpanded(prev => ({
        ...prev,
        [id]: prev[id] === undefined ? !uiDefault : !prev[id],
      }))
    },
    [defaultTrackExpandedFromPersona],
  )

  // Per-system "show hidden tracks" toggle. Off by default; when on,
  // the system's hidden tracks are folded into its render list
  // (appended, matching the persona's sort tail).
  const [systemHiddenVisible, setSystemHiddenVisible] = useState<Record<string, boolean>>({})
  const toggleSystemHidden = useCallback((id: string) => {
    setSystemHiddenVisible(prev => ({...prev, [id]: !prev[id]}))
  }, [])

  // Global "show hidden systems" toggle — the bottom-of-timeline
  // counterpart to the per-system "show hidden tracks" affordance.
  // Off by default; when on, every system in `appliedPersona.hiddenSystems`
  // is appended to the layout.
  const [hiddenSystemsShown, setHiddenSystemsShown] = useState(false)

  // Reset UI state when the applied persona id changes so the fresh
  // defaults take effect. Keeping per-persona state around would feel
  // unexpected — users switching from Web Dev → Raw expect Raw's
  // "everything expanded" defaults, not their prior Web Dev toggles.
  const personaId = appliedPersona?.persona.id
  useEffect(() => {
    setSystemExpanded({})
    setTrackExpanded({})
    setSystemHiddenVisible({})
    setHiddenSystemsShown(false)
  }, [personaId])

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
    bindingsStore,
  })

  // Base systems list (persona-derived if a persona is applied, else raw).
  // When the user has clicked the "show N hidden systems" footer
  // affordance, we append the persona's hidden systems so they render
  // at the bottom of the timeline.
  const baseSystems: System[] = useMemo(() => {
    const visible = appliedPersona?.systems ?? timeline.systems
    if (!appliedPersona || !hiddenSystemsShown || appliedPersona.hiddenSystems.length === 0) {
      return visible
    }
    return [...visible, ...appliedPersona.hiddenSystems]
  }, [appliedPersona, timeline.systems, hiddenSystemsShown])

  // Effective systems: fold any hidden tracks back in for systems where
  // the user has toggled "show hidden" on.
  const effectiveSystems = useMemo<System[]>(() => {
    const hiddenBySystem = appliedPersona?.hiddenTracksBySystem ?? {}
    return baseSystems.map(sys => {
      if (!systemHiddenVisible[sys.id]) return sys
      const hidden = hiddenBySystem[sys.id]
      if (!hidden || hidden.length === 0) return sys
      return {...sys, tracks: [...sys.tracks, ...hidden]}
    })
  }, [baseSystems, appliedPersona, systemHiddenVisible])

  // Precompute vertical layout with current expanded state. We reserve
  // `TIMELINE_OVERVIEW_HEIGHT_PX + TIMELINE_AXIS_HEIGHT_PX` at the top
  // for the sticky overview track and the sticky time ruler so the
  // first TimelineSystem starts just below them (systems are absolutely
  // positioned within the event surface by their `topPx`).
  const layout = useMemo(() => {
    const items: SystemLayout[] = []
    let y = TIMELINE_OVERVIEW_HEIGHT_PX + TIMELINE_AXIS_HEIGHT_PX
    for (const system of effectiveSystems) {
      const sysDefaultExpanded = defaultSystemExpandedFromPersona[system.id] ?? true
      const expanded = systemExpanded[system.id] ?? sysDefaultExpanded
      const headerHeightPx = SYSTEM_HEADER_HEIGHT_PX + SYSTEM_BORDER_HEIGHT_PX
      const tracksStartY = y + headerHeightPx
      const tracks: TrackLayout[] = []
      if (expanded) {
        let ty = tracksStartY
        for (const track of system.tracks) {
          const canExpand = containerDepth(track) > 1
          const trDefaultExpanded = defaultTrackExpandedFromPersona[track.id] ?? true
          const trackIsExpanded =
            canExpand && (trackExpanded[track.id] ?? trDefaultExpanded)
          const h = trackHeightPx(track, trackIsExpanded)
          tracks.push({track, topPx: ty, heightPx: h, expanded: trackIsExpanded, canExpand})
          ty += h
        }
      }
      const heightPx = computeSystemHeightPx(
        system,
        expanded,
        trackExpanded,
        defaultTrackExpandedFromPersona,
      )
      items.push({system, topPx: y, heightPx, headerHeightPx, expanded, tracks})
      y += heightPx
    }
    const footerHeightPx =
      appliedPersona && appliedPersona.hiddenSystems.length > 0
        ? HIDDEN_SYSTEMS_FOOTER_HEIGHT_PX
        : 0
    return {items, totalHeightPx: y + footerHeightPx, footerTopPx: y, footerHeightPx}
  }, [
    effectiveSystems,
    systemExpanded,
    trackExpanded,
    defaultSystemExpandedFromPersona,
    defaultTrackExpandedFromPersona,
    appliedPersona,
  ])

  const totalSpanMs = Math.max(timeline.end - timeline.start, MIN_SPAN_MS)
  const innerWidthPx = LABEL_WIDTH_PX + totalSpanMs * pxPerMs

  // Overview utilization (single curve). Computed once per `timeline`
  // identity — the parser hands us a fresh object per trace, so
  // memoizing on it is equivalent to "compute on parse". Runs on the
  // main thread; O(total depth-0 slices) plus a 7-tap smoothing pass,
  // well inside a frame. Used when the persona doesn't define bands.
  //
  // Scopes to the persona's `overviewSystems` (tracks marked
  // defaultExpanded) so the silhouette tracks the same subset as the
  // stacked bands rendered in front of it — otherwise the two layers
  // disagree visually: bands paint only the Main thread while the
  // silhouette still reflects every visible track's wall time, making
  // the silhouette look like a phantom mountain with nothing stacked
  // on top of it.
  const overviewUtilization = useMemo(
    () => buildOverviewUtilization(timeline, undefined, appliedPersona?.overviewSystems),
    [timeline, appliedPersona],
  )

  // Stacked category bands, computed on demand when the applied persona
  // defines any. Same cost profile as `buildOverviewUtilization` and
  // cached on both the timeline identity and the applied-persona
  // identity so persona switches recompute exactly once.
  const overviewBands = useMemo(() => {
    if (!appliedPersona || appliedPersona.bands.length === 0) return undefined
    return buildOverviewBands(timeline, appliedPersona)
  }, [timeline, appliedPersona])

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
    highlightRef: hoverHighlightRef,
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
    bindingsStore,
  })

  return (
    <div
      ref={scrollRef}
      // `select-none` (user-select: none) cascades to the whole timeline
      // surface so left-drag-to-select never also drags a native text
      // selection across row labels / axis / category tags.
      className="relative min-h-0 flex-1 overflow-auto select-none"
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
          bands={overviewBands}
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
        {visibleSystems.map(item => {
          const hiddenCount =
            appliedPersona?.hiddenTracksBySystem[item.system.id]?.length ?? 0
          return (
            <TimelineSystem
              key={item.system.id}
              layout={item}
              labelWidthPx={LABEL_WIDTH_PX}
              viewportTopPx={visibleTop}
              viewportBottomPx={visibleBottom}
              store={store}
              hiddenTrackCount={hiddenCount}
              hiddenTracksShown={systemHiddenVisible[item.system.id] === true}
              onToggle={() => toggleSystem(item.system.id)}
              onToggleTrack={toggleTrack}
              onToggleHidden={() => toggleSystemHidden(item.system.id)}
            />
          )
        })}
        <SelectionOverlay
          store={store}
          selectionStore={effectiveSelectionStore}
          labelWidthPx={LABEL_WIDTH_PX}
          totalHeightPx={layout.totalHeightPx}
        />
        {appliedPersona && appliedPersona.hiddenSystems.length > 0 && (
          <div
            data-testid="timeline-hidden-systems-footer"
            // Positioned inside the event surface so it scrolls with the
            // timeline content. Sticks to the left gutter (not the full
            // width) to stay visible regardless of horizontal scroll.
            className="absolute flex items-center"
            style={{
              top: layout.footerTopPx,
              left: 0,
              height: layout.footerHeightPx,
              paddingLeft: 12,
            }}
          >
            <button
              type="button"
              onClick={() => setHiddenSystemsShown(v => !v)}
              className="rounded border border-[#2d3748] bg-[#0b0f17]/80 px-2 py-0.5 text-xs text-[#a0aec0] hover:bg-[#1a202c] hover:text-[#e2e8f0]"
            >
              {hiddenSystemsShown
                ? `hide ${appliedPersona.hiddenSystems.length} hidden system${
                    appliedPersona.hiddenSystems.length === 1 ? '' : 's'
                  }`
                : `+${appliedPersona.hiddenSystems.length} hidden system${
                    appliedPersona.hiddenSystems.length === 1 ? '' : 's'
                  }`}
            </button>
          </div>
        )}
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
      {/*
        Hover highlight overlay. Fixed-positioned and pointer-events:none
        so it sits on top of the canvas without blocking hit-tests or
        scroll. `useTimelineHover` imperatively sets `transform`,
        `width`, `height`, and `opacity`; React never re-renders this
        node on cursor moves. Rendered below the tooltip in z-order so
        the tooltip text stays readable if it overlaps the outline.
      */}
      <div
        ref={hoverHighlightRef}
        data-testid="timeline-hover-highlight"
        aria-hidden="true"
        className="pointer-events-none fixed left-0 top-0 z-40 rounded-sm transition-opacity duration-75"
        style={{
          opacity: 0,
          transform: 'translate(0px, 0px)',
          width: 0,
          height: 0,
          // `outline` paints outside the element's box and never reserves
          // layout space, so the highlight wraps the slice rect without
          // eating into its interior (a `border` with `box-sizing:
          // border-box` would shave 2px off every edge of the painted
          // rect). A 1px dark halo via non-inset box-shadow keeps the
          // stroke readable on both bright yellow scripting and dark mint
          // user-JS backgrounds.
          outline: '2px solid rgba(255, 255, 255, 0.85)',
          outlineOffset: 0,
          boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.7)',
        }}
      />
    </div>
  )
}
