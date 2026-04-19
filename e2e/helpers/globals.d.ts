export {}

/**
 * Live viewport snapshot installed by `src/components/Timeline.tsx` while the
 * timeline is mounted. All fields are getters so reads always reflect the
 * current state. The canvas renderer commits every zoom tick synchronously,
 * so there's no live transform to expose — `pxPerMs` and `scrollLeft` are
 * always consistent with what's on screen.
 */
export interface PerfecttoTimelineSnapshot {
  readonly pxPerMs: number
  readonly scrollLeft: number
  readonly scrollTop: number
  readonly innerWidthPx: number
  readonly labelWidthPx: number
  readonly timelineStart: number
  readonly timelineEnd: number
  readonly scrollerRect:
    | {x: number; y: number; width: number; height: number}
    | null
}

declare global {
  interface Window {
    __perfecttoLongTasks?: Array<{start: number; dur: number}>
    __perfecttoTimeline?: PerfecttoTimelineSnapshot
  }
}
