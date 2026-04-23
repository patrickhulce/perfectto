import {
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
