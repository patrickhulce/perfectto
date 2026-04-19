/**
 * Tiny pub/sub for live viewport values (pxPerMs, scrollLeft, scroll size).
 *
 * Why this exists: canvas tracks need to redraw on every scroll/zoom tick,
 * but piping those values through React state would trigger a tree-wide
 * render per frame. Instead the zoom hook and scroll listener write into
 * this store and subscribers (one per canvas) schedule their own rAF
 * redraws. React is only involved when a track is added/removed or when the
 * expand state changes.
 */

export interface ViewportState {
  /** Committed zoom: pixels per millisecond. Always > 0 once known. */
  pxPerMs: number
  /** Native scroll offset on the outer scroller, in CSS pixels. */
  scrollLeft: number
  /** Native vertical scroll offset on the outer scroller, in CSS pixels. */
  scrollTop: number
  /** clientWidth of the outer scroller (viewport), in CSS pixels. */
  viewportWidth: number
  /** clientHeight of the outer scroller (viewport), in CSS pixels. */
  viewportHeight: number
  /**
   * Width of the sticky label gutter that sits to the left of the track
   * content area, in CSS pixels. Kept in the store so canvases can convert
   * their own local x → timeline ms without prop-drilling.
   */
  labelWidthPx: number
  /** Timeline start in ms. */
  timelineStart: number
  /** Timeline end in ms. */
  timelineEnd: number
}

export type Listener = (state: ViewportState) => void

export class ViewportStore {
  private state: ViewportState
  private listeners = new Set<Listener>()

  constructor(initial: ViewportState) {
    this.state = initial
  }

  get(): ViewportState {
    return this.state
  }

  /**
   * Shallow-merge `patch` into the current state and notify subscribers if
   * anything actually changed. The comparison is field-by-field on the keys
   * present in `patch` so a no-op scroll event doesn't spam redraws.
   */
  set(patch: Partial<ViewportState>): void {
    let changed = false
    for (const key of Object.keys(patch) as Array<keyof ViewportState>) {
      const next = patch[key]
      if (next === undefined) continue
      if (this.state[key] !== next) {
        changed = true
        break
      }
    }
    if (!changed) return
    this.state = {...this.state, ...patch} as ViewportState
    for (const fn of this.listeners) fn(this.state)
  }

  /** Replace the entire state atomically. Cheaper when many fields change. */
  replace(next: ViewportState): void {
    this.state = next
    for (const fn of this.listeners) fn(this.state)
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
}

export function createViewportStore(initial: ViewportState): ViewportStore {
  return new ViewportStore(initial)
}
