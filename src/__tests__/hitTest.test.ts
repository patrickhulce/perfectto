import type {Measure, Track} from '../core'
import {hitTestTrack} from '../components/timeline/hitTest'
import {
  EMPTY_SLICE_BUFFERS,
  buildSliceBuffers,
} from '../core/render/sliceBuffers'

const ROW = 22

function m(
  id: string,
  start: number,
  end: number,
  children: Measure[] = [],
): Measure {
  return {id, name: id, start, end, events: [], marks: [], measures: children}
}

function track(measures: Measure[]): Track {
  return {id: 't', name: 't', marks: [], measures}
}

describe('hitTestTrack', () => {
  it('misses on empty buffers', () => {
    const r = hitTestTrack(EMPTY_SLICE_BUFFERS, 1, 1, ROW, Infinity)
    expect(r.index).toBe(-1)
  })

  it('hits a depth-0 measure under the cursor', () => {
    const buffers = buildSliceBuffers(track([m('a', 0, 100)]))
    const hit = hitTestTrack(buffers, 50, ROW / 2, ROW, Infinity)
    expect(hit.index).toBe(0)
    expect(hit.depth).toBe(0)
    expect(buffers.measures[hit.index].id).toBe('a')
  })

  it('returns the deepest match when the cursor is over a child row', () => {
    // Long parent at depth 0 entirely covers a short child at depth 1. The
    // hit-test must pick the child when the cursor y is over the second row,
    // and the parent when it's over the first row.
    const buffers = buildSliceBuffers(
      track([m('parent', 0, 1000, [m('child', 400, 600)])]),
    )

    const onParentRow = hitTestTrack(buffers, 500, ROW / 2, ROW, Infinity)
    expect(buffers.measures[onParentRow.index].id).toBe('parent')

    const onChildRow = hitTestTrack(buffers, 500, ROW + ROW / 2, ROW, Infinity)
    expect(buffers.measures[onChildRow.index].id).toBe('child')
  })

  it('honors maxDepthExclusive for collapsed tracks', () => {
    const buffers = buildSliceBuffers(
      track([m('parent', 0, 1000, [m('child', 400, 600)])]),
    )
    // Cursor over the child row but the track is collapsed (maxDepth=1).
    const r = hitTestTrack(buffers, 500, ROW + 4, ROW, 1)
    expect(r.index).toBe(-1)
  })

  it('survives the long-parent / sub-pixel-child layout that motivates maxEndsPrefix', () => {
    // Same shape as the SliceBuffers regression test: a long ancestor at
    // index 0 wraps many tiny descendants. lowerBoundF32 on `starts` would
    // skip past the parent for cursors in the right half; lowerBoundF32 on
    // `maxEndsPrefix` must keep it reachable.
    const children: Measure[] = []
    for (let i = 0; i < 20; i++) children.push(m(`c${i}`, i * 10, i * 10 + 1))
    const buffers = buildSliceBuffers(
      track([m('parent', 0, 200, children)]),
    )

    const hitRight = hitTestTrack(buffers, 195, ROW / 2, ROW, Infinity)
    expect(buffers.measures[hitRight.index].id).toBe('parent')
  })

  it('misses cleanly when no slice is under the cursor at that depth', () => {
    const buffers = buildSliceBuffers(track([m('a', 0, 100)]))
    expect(hitTestTrack(buffers, 200, ROW / 2, ROW, Infinity).index).toBe(-1)
    expect(hitTestTrack(buffers, 50, ROW * 5, ROW, Infinity).index).toBe(-1)
  })

  it('rejects negative trackLocalY', () => {
    const buffers = buildSliceBuffers(track([m('a', 0, 100)]))
    expect(hitTestTrack(buffers, 50, -1, ROW, Infinity).index).toBe(-1)
  })
})
