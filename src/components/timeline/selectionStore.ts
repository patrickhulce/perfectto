/**
 * Pub/sub store for the user's time-range selection.
 *
 * Kept separate from {@link ViewportStore} so committing or updating a
 * selection doesn't wake up every track canvas — only the two overlays
 * that actually render it (the `TimelineOverview` mountain and the
 * `SelectionOverlay` div layered over the main timeline) plus the
 * `Aggregator` panel subscribe here.
 *
 * State:
 *  - `paneId`: which `TracePane` currently "owns" the selection. In
 *    multi-trace comparison view we still keep one global store but
 *    only one pane can show highlights at a time. The first non-null
 *    write tagged with a different paneId resets the previous pane's
 *    slots so highlights don't paint on two panes simultaneously.
 *    `null` when nothing is selected anywhere.
 *  - `committed`: the selection that survived a mouse release. `null`
 *    when there's no active selection. Consumers that care about final
 *    ranges (Aggregator, `Z` hotkey) read this.
 *  - `inProgress`: the live anchor/cursor during a drag. Consumers that
 *    render the preview rectangle read this (or fall back to committed
 *    when `inProgress` is null).
 *  - `selectedSlice`: sticky slice from a click, drives the
 *    tree-highlight overlay and the Aggregator's callstack readout.
 *  - `hoveredSlice`: transient slice under the cursor; cleared on
 *    pointerleave / pan.
 *
 * Setters take an optional `paneId` arg so the call sites in
 * `useTimelineSelection` / `useTimelineHover` can tag every write with
 * the originating pane. Calls without a `paneId` (tests, synthetic
 * uses) preserve the current owner — single-pane usage stays
 * indistinguishable from the pre-multi-trace behavior.
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

/**
 * Minimal identifier for a single slice in the timeline. Sufficient for
 * the tree-highlight affordance: start/end/depth uniquely determine the
 * pre-order descendant range (depth >= this.depth and span ⊆ [start,end]),
 * and trackId scopes that check to one track's canvas.
 *
 * `measureId` carries the parser-assigned `Measure.id` when the selection
 * originates from a real slice hit (click, deep-link resolver). Consumers
 * that need an exact back-pointer — e.g. the aggregator looking up the
 * selected measure to render its callstack — key off this field instead
 * of trying to re-match bounds, which would be ambiguous when two slices
 * share the same `[start, end, depth]` tuple.
 */
export interface SliceRef {
  trackId: string
  startMs: number
  endMs: number
  depth: number
  /** Parser-assigned `Measure.id`. Optional so synthetic selections keep working. */
  measureId?: string
}

export interface SelectionState {
  /**
   * Pane that currently owns the selection state. `null` when every
   * slot is empty. Only one pane can own state at a time; cross-pane
   * writes wipe the previous owner's slots.
   */
  paneId: string | null
  committed: SelectionRange | null
  inProgress: InProgressSelection | null
  /** Sticky slice chosen by click. Cleared by clicking empty canvas. */
  selectedSlice: SliceRef | null
  /** Transient slice under the cursor. Cleared on pointerleave / pan. */
  hoveredSlice: SliceRef | null
}

export type SelectionListener = (state: SelectionState) => void

/**
 * Minimal store surface every selection consumer can share. The
 * concrete {@link SelectionStore} is the global one (App-level); a
 * {@link PaneSelectionView} wraps it and presents the same interface
 * scoped to a single pane (filtered reads, auto-tagged writes), so
 * deeper components (`Timeline` and below) don't have to care which
 * one they're talking to.
 */
export interface SelectionStoreLike {
  get(): SelectionState
  subscribe(fn: SelectionListener): () => void
  setInProgress(next: InProgressSelection | null, paneId?: string | null): void
  setCommitted(next: SelectionRange | null, paneId?: string | null): void
  setHoveredSlice(next: SliceRef | null, paneId?: string | null): void
  setSelectedSlice(next: SliceRef | null, paneId?: string | null): void
  cancel(): void
  commit(): void
  clear(): void
}

/**
 * Result of resolving a setter's `paneId` arg against the current owner.
 *
 *  - `nextPaneId`: the new value of `state.paneId` after this write.
 *  - `resetOthers`: when `true`, the other state slots must be wiped
 *    before applying the new value because a different pane is taking
 *    over ownership. Falls through naturally for null writes (which
 *    don't take ownership) and for same-pane writes.
 */
interface OwnershipResolution {
  nextPaneId: string | null
  resetOthers: boolean
}

export class SelectionStore implements SelectionStoreLike {
  private state: SelectionState = {
    paneId: null,
    committed: null,
    inProgress: null,
    selectedSlice: null,
    hoveredSlice: null,
  }
  private listeners = new Set<SelectionListener>()

  get(): SelectionState {
    return this.state
  }

  setInProgress(next: InProgressSelection | null, paneId?: string | null): void {
    const own = this.resolveOwnership(paneId, next !== null)
    if (
      !own.resetOthers &&
      own.nextPaneId === this.state.paneId &&
      rangesEqual(this.state.inProgress, next)
    ) {
      return
    }
    this.applyWrite(own, 'inProgress', next)
  }

  setCommitted(next: SelectionRange | null, paneId?: string | null): void {
    const own = this.resolveOwnership(paneId, next !== null)
    if (
      !own.resetOthers &&
      own.nextPaneId === this.state.paneId &&
      rangesEqual(this.state.committed, next)
    ) {
      return
    }
    this.applyWrite(own, 'committed', next)
  }

  setHoveredSlice(next: SliceRef | null, paneId?: string | null): void {
    const own = this.resolveOwnership(paneId, next !== null)
    if (
      !own.resetOthers &&
      own.nextPaneId === this.state.paneId &&
      slicesEqual(this.state.hoveredSlice, next)
    ) {
      return
    }
    this.applyWrite(own, 'hoveredSlice', next)
  }

  setSelectedSlice(next: SliceRef | null, paneId?: string | null): void {
    const own = this.resolveOwnership(paneId, next !== null)
    if (
      !own.resetOthers &&
      own.nextPaneId === this.state.paneId &&
      slicesEqual(this.state.selectedSlice, next)
    ) {
      return
    }
    this.applyWrite(own, 'selectedSlice', next)
  }

  /** Drop the in-progress drag without committing. */
  cancel(): void {
    if (this.state.inProgress === null) return
    this.state = {...this.state, inProgress: null}
    this.maybeClearOwner()
    this.emit()
  }

  /** Commit the current in-progress range (if any) and clear inProgress. */
  commit(): void {
    const ip = this.state.inProgress
    if (ip === null) return
    const committed: SelectionRange = {startMs: ip.startMs, endMs: ip.endMs}
    this.state = {...this.state, committed, inProgress: null}
    this.emit()
  }

  clear(): void {
    if (
      this.state.paneId === null &&
      this.state.committed === null &&
      this.state.inProgress === null &&
      this.state.selectedSlice === null &&
      this.state.hoveredSlice === null
    ) {
      return
    }
    this.state = {
      paneId: null,
      committed: null,
      inProgress: null,
      selectedSlice: null,
      hoveredSlice: null,
    }
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

  /**
   * Decide what `state.paneId` should be after a setter, and whether
   * the other slots need to be wiped first because a different pane is
   * taking over.
   *
   * Rules:
   *  - Null writes never change ownership and never reset (clearing
   *    your own hover shouldn't disturb the other pane).
   *  - Writes without an explicit `paneId` (back-compat for tests and
   *    legacy synthetic uses) preserve the current owner.
   *  - Non-null writes with an explicit `paneId` always set ownership
   *    to that pane. If a *different* pane was the previous owner, the
   *    other slots are reset so we never paint highlights on two panes
   *    simultaneously.
   */
  private resolveOwnership(
    paneId: string | null | undefined,
    writingNonNull: boolean,
  ): OwnershipResolution {
    const prev = this.state.paneId
    if (paneId === undefined || !writingNonNull) {
      return {nextPaneId: prev, resetOthers: false}
    }
    return {nextPaneId: paneId, resetOthers: prev !== null && prev !== paneId}
  }

  private applyWrite<K extends Exclude<keyof SelectionState, 'paneId'>>(
    own: OwnershipResolution,
    key: K,
    value: SelectionState[K],
  ): void {
    if (own.resetOthers) {
      this.state = {
        paneId: own.nextPaneId,
        committed: null,
        inProgress: null,
        selectedSlice: null,
        hoveredSlice: null,
        [key]: value,
      }
    } else {
      this.state = {...this.state, paneId: own.nextPaneId, [key]: value}
    }
    this.maybeClearOwner()
    this.emit()
  }

  /**
   * Drop the paneId back to `null` once every slot is empty. Keeps the
   * "no selection anywhere" fact a stable observable; consumers can
   * trust `paneId === null` as a synonym for "store is idle".
   */
  private maybeClearOwner(): void {
    if (this.state.paneId === null) return
    if (
      this.state.committed === null &&
      this.state.inProgress === null &&
      this.state.selectedSlice === null &&
      this.state.hoveredSlice === null
    ) {
      this.state = {...this.state, paneId: null}
    }
  }
}

export function createSelectionStore(): SelectionStore {
  return new SelectionStore()
}

/**
 * Pane-scoped view onto a global {@link SelectionStore}. Wraps every
 * read so deeper components (`CanvasTrackRenderer`, `SelectionOverlay`,
 * `TimelineOverview`, hover/selection hooks) see "no selection" when
 * the store's current owner is a different pane — even though there's
 * still one global store underneath. Writes are forwarded with the
 * bound `paneId` attached, which lets the global store enforce
 * single-pane ownership without consumers ever needing to thread
 * `paneId` through their call sites.
 *
 * The view emits its own filtered state on every global change so
 * subscribers refresh consistently when ownership flips. Same
 * `subscribe` semantics as the underlying store.
 */
export class PaneSelectionView implements SelectionStoreLike {
  private static readonly EMPTY_STATE: SelectionState = {
    paneId: null,
    committed: null,
    inProgress: null,
    selectedSlice: null,
    hoveredSlice: null,
  }

  constructor(
    private readonly global: SelectionStore,
    private readonly paneId: string,
  ) {}

  get(): SelectionState {
    const s = this.global.get()
    if (s.paneId !== null && s.paneId !== this.paneId) {
      return PaneSelectionView.EMPTY_STATE
    }
    return s
  }

  subscribe(fn: SelectionListener): () => void {
    let lastEmitted: SelectionState = this.get()
    return this.global.subscribe(() => {
      const next = this.get()
      // Suppress emission when the filtered state is identical to what
      // we last broadcast — flips between "owned by other pane" and
      // "still owned by other pane" both look like the empty state, no
      // sense waking subscribers up.
      if (next === lastEmitted) return
      lastEmitted = next
      fn(next)
    })
  }

  setInProgress(next: InProgressSelection | null, paneId?: string | null): void {
    this.global.setInProgress(next, paneId ?? this.paneId)
  }

  setCommitted(next: SelectionRange | null, paneId?: string | null): void {
    this.global.setCommitted(next, paneId ?? this.paneId)
  }

  setHoveredSlice(next: SliceRef | null, paneId?: string | null): void {
    this.global.setHoveredSlice(next, paneId ?? this.paneId)
  }

  setSelectedSlice(next: SliceRef | null, paneId?: string | null): void {
    this.global.setSelectedSlice(next, paneId ?? this.paneId)
  }

  cancel(): void {
    // Only roll back our own pane's drag — if the global store is
    // owned by another pane (a stale reference), don't touch it.
    if (this.global.get().paneId !== this.paneId) return
    this.global.cancel()
  }

  commit(): void {
    if (this.global.get().paneId !== this.paneId) return
    this.global.commit()
  }

  clear(): void {
    if (this.global.get().paneId !== this.paneId) return
    this.global.clear()
  }
}

export function createPaneSelectionView(
  global: SelectionStore,
  paneId: string,
): PaneSelectionView {
  return new PaneSelectionView(global, paneId)
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

function slicesEqual(
  a: SliceRef | null | undefined,
  b: SliceRef | null | undefined,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.trackId === b.trackId &&
    a.startMs === b.startMs &&
    a.endMs === b.endMs &&
    a.depth === b.depth &&
    a.measureId === b.measureId
  )
}
