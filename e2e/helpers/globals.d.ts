export {}

/**
 * Live viewport snapshot installed by `src/components/Timeline.tsx` while the
 * timeline is mounted. All fields are getters so reads always reflect the
 * current (possibly mid-gesture) state, including the compositor-only
 * `effectiveScale` / `effectiveTranslatePx` that drive the zoom transform.
 */
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
