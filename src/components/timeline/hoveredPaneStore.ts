/**
 * Tiny pub/sub for "which pane is currently under the cursor".
 *
 * Lives outside `SelectionStore` so the answer to "should this pane's
 * keybind handler fire?" stays orthogonal to "does any pane have a
 * selection right now?". Kept dead simple: one nullable string,
 * subscribers are notified on every change.
 *
 * Updated by each `Timeline` from scroller `pointerenter` /
 * `pointerleave`. Read by the global `keydown` handler in
 * `useTimelineViewport.ts` so `Z`, `Escape`, `W/S/A/D`, etc. fire only
 * on the pane the user is hovering — no input bleed across panes in
 * the multi-trace comparison view, and a no-op when the cursor sits on
 * the `Aggregator` or any non-Timeline area.
 */

export type HoveredPaneListener = (paneId: string | null) => void

export class HoveredPaneStore {
  private paneId: string | null = null
  private listeners = new Set<HoveredPaneListener>()

  get(): string | null {
    return this.paneId
  }

  set(next: string | null): void {
    if (this.paneId === next) return
    this.paneId = next
    for (const fn of this.listeners) fn(next)
  }

  /**
   * Atomic "leave" that only fires when the caller still owns the
   * pointer focus. Avoids a race where pane A's `pointerleave` clears
   * the store *after* pane B's `pointerenter` already wrote its id —
   * which would leave the store stuck at `null` until the user
   * wiggled the cursor.
   */
  clearIf(paneId: string): void {
    if (this.paneId !== paneId) return
    this.paneId = null
    for (const fn of this.listeners) fn(null)
  }

  subscribe(fn: HoveredPaneListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
}

export function createHoveredPaneStore(): HoveredPaneStore {
  return new HoveredPaneStore()
}
