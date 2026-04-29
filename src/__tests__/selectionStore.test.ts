import {
  createPaneSelectionView,
  createSelectionStore,
  type SelectionState,
  type SliceRef,
} from '../components/timeline/selectionStore'

function slice(
  trackId: string,
  startMs: number,
  endMs: number,
  depth: number,
): SliceRef {
  return {trackId, startMs, endMs, depth}
}

describe('SelectionStore slice selection', () => {
  it('starts with both slice fields null', () => {
    const s = createSelectionStore()
    expect(s.get().hoveredSlice).toBeNull()
    expect(s.get().selectedSlice).toBeNull()
  })

  it('setHoveredSlice writes and emits on change', () => {
    const s = createSelectionStore()
    const states: SelectionState[] = []
    s.subscribe(st => states.push(st))
    s.setHoveredSlice(slice('t1', 0, 10, 0))
    expect(s.get().hoveredSlice).toEqual(slice('t1', 0, 10, 0))
    expect(states).toHaveLength(1)
  })

  it('setHoveredSlice is a no-op when the value is unchanged', () => {
    const s = createSelectionStore()
    s.setHoveredSlice(slice('t1', 0, 10, 0))
    let emits = 0
    s.subscribe(() => emits++)
    s.setHoveredSlice(slice('t1', 0, 10, 0))
    expect(emits).toBe(0)
  })

  it('setSelectedSlice is independent of hoveredSlice', () => {
    const s = createSelectionStore()
    s.setHoveredSlice(slice('t1', 0, 10, 0))
    s.setSelectedSlice(slice('t2', 5, 15, 1))
    expect(s.get().hoveredSlice).toEqual(slice('t1', 0, 10, 0))
    expect(s.get().selectedSlice).toEqual(slice('t2', 5, 15, 1))
  })

  it('time-range mutations do not touch slice fields', () => {
    const s = createSelectionStore()
    s.setHoveredSlice(slice('t1', 0, 10, 0))
    s.setSelectedSlice(slice('t2', 5, 15, 1))
    s.setCommitted({startMs: 100, endMs: 200})
    expect(s.get().hoveredSlice).not.toBeNull()
    expect(s.get().selectedSlice).not.toBeNull()
    expect(s.get().committed).toEqual({startMs: 100, endMs: 200})
  })

  it('slice mutations do not touch time-range fields', () => {
    const s = createSelectionStore()
    s.setCommitted({startMs: 0, endMs: 10})
    s.setInProgress({anchorMs: 0, startMs: 0, endMs: 5})
    s.setSelectedSlice(slice('t1', 0, 10, 0))
    expect(s.get().committed).toEqual({startMs: 0, endMs: 10})
    expect(s.get().inProgress).toEqual({anchorMs: 0, startMs: 0, endMs: 5})
  })

  it('clear() wipes slice selection alongside ranges', () => {
    const s = createSelectionStore()
    s.setCommitted({startMs: 0, endMs: 10})
    s.setHoveredSlice(slice('t1', 0, 10, 0))
    s.setSelectedSlice(slice('t2', 5, 15, 1))
    s.clear()
    expect(s.get().committed).toBeNull()
    expect(s.get().inProgress).toBeNull()
    expect(s.get().hoveredSlice).toBeNull()
    expect(s.get().selectedSlice).toBeNull()
  })

  it('commit() preserves slice selection (orthogonal concern)', () => {
    const s = createSelectionStore()
    s.setSelectedSlice(slice('t1', 0, 10, 0))
    s.setInProgress({anchorMs: 0, startMs: 0, endMs: 5})
    s.commit()
    expect(s.get().committed).toEqual({startMs: 0, endMs: 5})
    expect(s.get().selectedSlice).toEqual(slice('t1', 0, 10, 0))
  })
})

describe('SelectionStore paneId ownership', () => {
  it('starts with paneId null and does not change for untagged writes', () => {
    const s = createSelectionStore()
    expect(s.get().paneId).toBeNull()
    s.setSelectedSlice(slice('t1', 0, 10, 0))
    expect(s.get().paneId).toBeNull()
  })

  it('a tagged write claims ownership for the originating pane', () => {
    const s = createSelectionStore()
    s.setSelectedSlice(slice('t1', 0, 10, 0), 'pane-A')
    expect(s.get().paneId).toBe('pane-A')
    expect(s.get().selectedSlice).toEqual(slice('t1', 0, 10, 0))
  })

  it('cross-pane non-null write resets the previous owner s slots before applying', () => {
    const s = createSelectionStore()
    // pane-A claims selection (committed range + slice).
    s.setCommitted({startMs: 0, endMs: 100}, 'pane-A')
    s.setSelectedSlice(slice('t1', 0, 10, 0), 'pane-A')
    expect(s.get().paneId).toBe('pane-A')

    // pane-B starts hovering — should wipe pane-A s state since only one
    // pane is allowed to show highlights at a time.
    s.setHoveredSlice(slice('t2', 5, 7, 0), 'pane-B')
    const state = s.get()
    expect(state.paneId).toBe('pane-B')
    expect(state.hoveredSlice).toEqual(slice('t2', 5, 7, 0))
    expect(state.committed).toBeNull()
    expect(state.selectedSlice).toBeNull()
  })

  it('null writes do not change ownership', () => {
    const s = createSelectionStore()
    s.setSelectedSlice(slice('t1', 0, 10, 0), 'pane-A')
    s.setHoveredSlice(null, 'pane-B')
    // Ownership stays with pane-A since the null write was just a clear.
    expect(s.get().paneId).toBe('pane-A')
    expect(s.get().selectedSlice).toEqual(slice('t1', 0, 10, 0))
  })

  it('ownership clears when every slot is empty again', () => {
    const s = createSelectionStore()
    s.setSelectedSlice(slice('t1', 0, 10, 0), 'pane-A')
    expect(s.get().paneId).toBe('pane-A')
    s.setSelectedSlice(null, 'pane-A')
    expect(s.get().paneId).toBeNull()
  })
})

describe('PaneSelectionView (per-pane wrapper)', () => {
  it('filters reads when a different pane owns the global state', () => {
    const global = createSelectionStore()
    const viewA = createPaneSelectionView(global, 'pane-A')
    const viewB = createPaneSelectionView(global, 'pane-B')

    viewA.setSelectedSlice(slice('t1', 0, 10, 0))
    expect(viewA.get().selectedSlice).toEqual(slice('t1', 0, 10, 0))
    // From pane-B s perspective the store looks empty even though
    // pane-A wrote into it.
    expect(viewB.get().selectedSlice).toBeNull()
    expect(viewB.get().paneId).toBeNull()
  })

  it('subscribers see consistent filtered state across cross-pane flips', () => {
    const global = createSelectionStore()
    const viewA = createPaneSelectionView(global, 'pane-A')
    const seen: SelectionState[] = []
    viewA.subscribe(state => seen.push(state))

    viewA.setSelectedSlice(slice('t1', 0, 10, 0))
    const viewB = createPaneSelectionView(global, 'pane-B')
    viewB.setSelectedSlice(slice('t2', 5, 15, 0))

    // pane-A first sees its own slice, then sees its filtered view
    // collapse to empty when pane-B takes over.
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen[0].selectedSlice).toEqual(slice('t1', 0, 10, 0))
    const last = seen[seen.length - 1]
    expect(last.selectedSlice).toBeNull()
    expect(last.paneId).toBeNull()
  })

  it('cancel/commit/clear no-op when the global store is owned by a different pane', () => {
    const global = createSelectionStore()
    const viewA = createPaneSelectionView(global, 'pane-A')
    const viewB = createPaneSelectionView(global, 'pane-B')

    viewA.setInProgress({anchorMs: 0, startMs: 0, endMs: 5})
    expect(global.get().inProgress).toEqual({anchorMs: 0, startMs: 0, endMs: 5})

    // pane-B trying to cancel pane-A s drag must not actually clear it.
    viewB.cancel()
    expect(global.get().inProgress).toEqual({anchorMs: 0, startMs: 0, endMs: 5})

    // pane-A s own cancel works.
    viewA.cancel()
    expect(global.get().inProgress).toBeNull()
  })
})
