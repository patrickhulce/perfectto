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

  describe('minHitboxMs widening', () => {
    it('hits a sub-pixel slice when the cursor is within the widened range', () => {
      // 0.01ms slice centered at 50.005ms. A 1ms hitbox widens it to
      // ~[49.505, 50.505], so cursors up to ~0.5ms on either side
      // should register.
      const buffers = buildSliceBuffers(track([m('tiny', 50, 50.01)]))
      const hitLeft = hitTestTrack(buffers, 49.7, ROW / 2, ROW, Infinity, 1)
      expect(hitLeft.index).toBe(0)
      const hitRight = hitTestTrack(buffers, 50.3, ROW / 2, ROW, Infinity, 1)
      expect(hitRight.index).toBe(0)
      // Outside the widened range — still a miss.
      const miss = hitTestTrack(buffers, 52, ROW / 2, ROW, Infinity, 1)
      expect(miss.index).toBe(-1)
    })

    it('exact containment wins over widened-only neighbors', () => {
      // Two adjacent tiny slices: 'a' at [10, 10.05], 'b' at [10.5,
      // 10.55]. With a 2ms hitbox both widen to contain cursor=10.3,
      // but 'a' is also closer so nearest-center should prefer it. A
      // cursor at exactly 10.52 is inside 'b' exactly — exact hit must
      // win regardless of which is nearer by center.
      const buffers = buildSliceBuffers(
        track([m('a', 10, 10.05), m('b', 10.5, 10.55)]),
      )
      const bNearestCenter = hitTestTrack(buffers, 10.52, ROW / 2, ROW, Infinity, 2)
      expect(buffers.measures[bNearestCenter.index].id).toBe('b')

      // Cursor well between them but slightly closer to 'a': widened
      // nearest-center picks 'a'.
      const aNearestCenter = hitTestTrack(buffers, 10.22, ROW / 2, ROW, Infinity, 2)
      expect(buffers.measures[aNearestCenter.index].id).toBe('a')
    })

    it('does not widen when minHitboxMs is zero (back-compat)', () => {
      const buffers = buildSliceBuffers(track([m('tiny', 50, 50.01)]))
      // 0.3ms outside the slice — legacy behavior should miss.
      expect(hitTestTrack(buffers, 50.3, ROW / 2, ROW, Infinity, 0).index).toBe(-1)
      expect(hitTestTrack(buffers, 50.3, ROW / 2, ROW, Infinity).index).toBe(-1)
    })

    it('still reaches a wide slice with its true [start, end] range', () => {
      // 1000ms slice plus a 1ms hitbox — cursor inside the real range
      // should hit via the exact-containment path.
      const buffers = buildSliceBuffers(track([m('wide', 0, 1000)]))
      const hit = hitTestTrack(buffers, 500, ROW / 2, ROW, Infinity, 1)
      expect(buffers.measures[hit.index].id).toBe('wide')
    })
  })
})
