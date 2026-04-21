/**
 * Pub/sub store for the user's time-range selection.
 *
 * Kept separate from {@link ViewportStore} so committing or updating a
 * selection doesn't wake up every track canvas — only the two overlays
 * that actually render it (the `TimelineOverview` mountain and the
 * `SelectionOverlay` div layered over the main timeline) plus the
 * `Aggregator` panel subscribe here.
 *
 * Two pieces of state:
 *  - `committed`: the selection that survived a mouse release. `null`
 *    when there's no active selection. Consumers that care about final
 *    ranges (Aggregator, `Z` hotkey) read this.
 *  - `inProgress`: the live anchor/cursor during a drag. Consumers that
 *    render the preview rectangle read this (or fall back to committed
 *    when `inProgress` is null).
 */

export interface SelectionRange {
  /** Timeline ms at the earlier end of the range. */
  startMs: number
  /** Timeline ms at the later end of the range. Always > startMs. */
  endMs: number
}

export interface InProgressSelection extends SelectionRange {
  /**
   * The initial ms where the user pressed the mouse down. Kept so the
   * hook can draw the range consistently when the cursor drags to either
   * side of the anchor.
   */
  anchorMs: number
}

export interface SelectionState {
  committed: SelectionRange | null
  inProgress: InProgressSelection | null
}

export type SelectionListener = (state: SelectionState) => void

export class SelectionStore {
  private state: SelectionState = {committed: null, inProgress: null}
  private listeners = new Set<SelectionListener>()

  get(): SelectionState {
    return this.state
  }

  setInProgress(next: InProgressSelection | null): void {
    if (rangesEqual(this.state.inProgress, next)) return
    this.state = {...this.state, inProgress: next}
    this.emit()
  }

  setCommitted(next: SelectionRange | null): void {
    if (rangesEqual(this.state.committed, next)) return
    this.state = {...this.state, committed: next}
    this.emit()
  }

  /** Drop the in-progress drag without committing. */
  cancel(): void {
    if (this.state.inProgress === null) return
    this.state = {...this.state, inProgress: null}
    this.emit()
  }

  /** Commit the current in-progress range (if any) and clear inProgress. */
  commit(): void {
    const ip = this.state.inProgress
    if (ip === null) return
    const committed: SelectionRange = {startMs: ip.startMs, endMs: ip.endMs}
    this.state = {committed, inProgress: null}
    this.emit()
  }

  clear(): void {
    if (this.state.committed === null && this.state.inProgress === null) return
    this.state = {committed: null, inProgress: null}
    this.emit()
  }

  subscribe(fn: SelectionListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state)
  }
}

export function createSelectionStore(): SelectionStore {
  return new SelectionStore()
}

function rangesEqual(
  a: SelectionRange | null | undefined,
  b: SelectionRange | null | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.startMs === b.startMs &&
    a.endMs === b.endMs &&
    (a as InProgressSelection).anchorMs ===
      (b as InProgressSelection).anchorMs
  )
}
