export interface LinkedViewportState {
  /** Pane that most recently published the linked viewport. */
  sourcePaneId: string
  /**
   * Fraction of the source trace's total span at the left edge of the
   * visible content area (i.e. `(scrollLeft / pxPerMs) / sourceSpan`).
   * Range `[0, 1]` in normal use; subscribers clamp regardless.
   *
   * Why fractions instead of absolute ms? The two compared traces
   * almost never have the same wall-clock duration. Replaying ms
   * 1:1 across them would put the second pane on a totally
   * different *region* of its trace. Working in span-relative units
   * means "I'm looking at 12% to 18% of trace A" stays
   * "12% to 18% of trace B" — the intuitive contract for `vs.`
   * comparison.
   */
  startFraction: number
  /**
   * Fraction of the source trace covered by the visible content
   * width (`(contentWidthPx / pxPerMs) / sourceSpan`). Combined
   * with `startFraction` to derive the destination pane's
   * `pxPerMs` and scroll offset locally.
   */
  widthFraction: number
  /** Monotonic write counter so subscribers can ignore stale echoes. */
  epoch: number
}

export type LinkedViewportListener = (state: LinkedViewportState) => void
export type LinkedViewportEnabledListener = (enabled: boolean) => void
export type LinkedViewportResyncListener = (paneId: string) => void

export class LinkedViewportStore {
  private state: LinkedViewportState | null = null
  private listeners = new Set<LinkedViewportListener>()
  private enabledListeners = new Set<LinkedViewportEnabledListener>()
  private resyncListeners = new Set<LinkedViewportResyncListener>()
  private nextEpoch = 0
  private enabled = true

  get(): LinkedViewportState | null {
    return this.state
  }

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(next: boolean): void {
    if (this.enabled === next) return
    this.enabled = next
    for (const fn of this.enabledListeners) fn(next)
  }

  /**
   * Subscribe to enable/disable transitions. Returns an unsubscribe.
   * Used by the header toggle button to flip its icon state without
   * making the whole header re-render on every viewport publish.
   */
  subscribeEnabled(fn: LinkedViewportEnabledListener): () => void {
    this.enabledListeners.add(fn)
    return () => {
      this.enabledListeners.delete(fn)
    }
  }

  publish(next: Omit<LinkedViewportState, 'epoch'>): void {
    if (!this.enabled) return
    this.nextEpoch += 1
    this.state = {...next, epoch: this.nextEpoch}
    for (const fn of this.listeners) fn(this.state)
  }

  subscribe(fn: LinkedViewportListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * Subscribe to "designated pane should republish its current
   * viewport" requests. Used by `useTimelineZoom` so the header
   * toggle can pick a pane (the hovered one, falling back to the
   * last source, falling back to pane[0]) and have *that* pane
   * snap the other pane to its viewport on sync re-enable.
   */
  subscribeResyncRequest(fn: LinkedViewportResyncListener): () => void {
    this.resyncListeners.add(fn)
    return () => {
      this.resyncListeners.delete(fn)
    }
  }

  /**
   * Ask the pane with this id to republish its current viewport.
   * No-op when sync is disabled — callers should `setEnabled(true)`
   * before calling.
   */
  requestResyncFrom(paneId: string): void {
    if (!this.enabled) return
    for (const fn of this.resyncListeners) fn(paneId)
  }

  /**
   * Source paneId of the most recent publish, or null if nothing
   * has published yet. Used by the toggle handler to fall back to
   * "the last pane that drove sync" when no pane is hovered at the
   * moment the user re-enables.
   */
  lastSourcePaneId(): string | null {
    return this.state?.sourcePaneId ?? null
  }
}

export function createLinkedViewportStore(): LinkedViewportStore {
  return new LinkedViewportStore()
}
