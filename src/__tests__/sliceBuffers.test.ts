import type {CompactionReport, Mark, Measure, Track} from '../core'
import {
  SLICE_FLAG_COMPACTED,
  buildAncestorChain,
  buildMarkBuffers,
  buildSliceBuffers,
  buildSliceMipmap,
  findMeasureIndexById,
  lowerBoundF32,
  maxDepthPlusOne,
} from '../core/render/sliceBuffers'
import {DEFAULT_MARK_COLOR, DEFAULT_MEASURE_COLOR} from '../core/render/packColor'

function m(
  id: string,
  start: number,
  end: number,
  children: Measure[] = [],
  color?: string,
): Measure {
  return {
    id,
    name: id,
    start,
    end,
    color,
    events: [],
    marks: [],
    measures: children,
  }
}

function mark(id: string, time: number, color?: string): Mark {
  return {id, name: id, time, color, events: []}
}

function track(measures: Measure[], marks: Mark[] = []): Track {
  return {id: 't', name: 't', marks, measures}
}

describe('buildSliceBuffers', () => {
  it('returns the shared empty buffers for an empty track', () => {
    const b = buildSliceBuffers(track([]))
    expect(b.count).toBe(0)
    expect(b.starts.length).toBe(0)
    expect(b.ends.length).toBe(0)
  })

  it('flattens nested measures in pre-order with correct depths', () => {
    const inner = m('inner', 10, 20)
    const middle = m('middle', 5, 30, [inner])
    const sibling = m('sibling', 40, 50)
    const root = m('root', 0, 100, [middle, sibling])

    const b = buildSliceBuffers(track([root]))

    expect(b.count).toBe(4)
    expect(Array.from(b.starts)).toEqual([0, 5, 10, 40])
    expect(Array.from(b.ends)).toEqual([100, 30, 20, 50])
    // root=0, middle=1, inner=2, sibling=1
    expect(Array.from(b.depths)).toEqual([0, 1, 2, 1])
    expect(b.measures.map(x => x.id)).toEqual(['root', 'middle', 'inner', 'sibling'])
  })

  it('starts are sorted ascending (pre-order preserves order)', () => {
    const root = m('r', 0, 100, [
      m('a', 10, 20, [m('a.1', 11, 12), m('a.2', 15, 18)]),
      m('b', 25, 50, [m('b.1', 26, 30)]),
      m('c', 60, 70),
    ])
    const b = buildSliceBuffers(track([root]))
    for (let i = 1; i < b.count; i++) {
      expect(b.starts[i]).toBeGreaterThanOrEqual(b.starts[i - 1])
    }
  })

  it('packs colors (including defaults) into 0xRRGGBBAA', () => {
    const b = buildSliceBuffers(track([m('red', 0, 1, [], '#ff0000'), m('def', 1, 2)]))
    expect(b.colors[0] >>> 0).toBe(0xff0000ff)
    expect(b.colors[1] >>> 0).toBe(DEFAULT_MEASURE_COLOR >>> 0)
  })

  it('maxDepthPlusOne reflects the deepest slice + 1', () => {
    const b = buildSliceBuffers(
      track([m('a', 0, 10, [m('b', 1, 5, [m('c', 2, 3)])])]),
    )
    expect(maxDepthPlusOne(b)).toBe(3)
  })

  it('maxEndsPrefix is a non-decreasing running max of ends', () => {
    // Layout:
    //   root   [0..100]          depth 0
    //     a    [5..30]           depth 1
    //       ai [10..20]          depth 2
    //     b    [40..50]          depth 1
    //   sibling[200..300]        depth 0
    const inner = m('ai', 10, 20)
    const middle = m('a', 5, 30, [inner])
    const b1 = m('b', 40, 50)
    const root = m('root', 0, 100, [middle, b1])
    const sibling = m('sibling', 200, 300)
    const b = buildSliceBuffers(track([root, sibling]))

    // Pre-order emits: root, a, ai, b, sibling
    expect(Array.from(b.starts)).toEqual([0, 5, 10, 40, 200])
    expect(Array.from(b.ends)).toEqual([100, 30, 20, 50, 300])
    expect(Array.from(b.maxEndsPrefix)).toEqual([100, 100, 100, 100, 300])

    // Key invariant we want the canvas culler to exploit: binary-search on
    // maxEndsPrefix for a viewport that starts mid-parent picks up index 0,
    // so the long-spanning root survives the cull.
    expect(lowerBoundF32(b.maxEndsPrefix, b.count, 60)).toBe(0)
    // Viewport strictly after root/a/ai/b: prefix up through index 3 is
    // still 100, so binary search lands on the sibling (index 4).
    expect(lowerBoundF32(b.maxEndsPrefix, b.count, 150)).toBe(4)
  })

  it('parentIndex points each slice at its direct ancestor (-1 for roots)', () => {
    // Layout:
    //   root             depth 0  (index 0)
    //     middle         depth 1  (index 1)
    //       inner        depth 2  (index 2)
    //     sibling        depth 1  (index 3)
    //   peer             depth 0  (index 4)
    const inner = m('inner', 10, 20)
    const middle = m('middle', 5, 30, [inner])
    const sibling = m('sibling', 40, 50)
    const root = m('root', 0, 100, [middle, sibling])
    const peer = m('peer', 200, 300)
    const b = buildSliceBuffers(track([root, peer]))

    expect(Array.from(b.parentIndex)).toEqual([-1, 0, 1, 0, -1])
    // parentIndex is the authoritative ancestor pointer; parent indices
    // always precede the slice (pre-order) so the walk terminates cleanly.
    for (let i = 0; i < b.count; i++) {
      expect(b.parentIndex[i]).toBeLessThan(i)
    }
  })

  it('buildAncestorChain walks parentIndex root-to-leaf', () => {
    const inner = m('inner', 10, 20)
    const middle = m('middle', 5, 30, [inner])
    const root = m('root', 0, 100, [middle])
    const b = buildSliceBuffers(track([root]))

    expect(buildAncestorChain(b, 2)).toEqual([0, 1, 2])
    expect(buildAncestorChain(b, 0)).toEqual([0])
    expect(buildAncestorChain(b, -1)).toEqual([])
    expect(buildAncestorChain(b, 99)).toEqual([])
  })

  it('findMeasureIndexById returns the matching buffer index', () => {
    const inner = m('needle', 10, 20)
    const root = m('root', 0, 100, [inner])
    const b = buildSliceBuffers(track([root]))

    expect(findMeasureIndexById(b, 'needle')).toBe(1)
    expect(findMeasureIndexById(b, 'root')).toBe(0)
    expect(findMeasureIndexById(b, 'missing')).toBe(-1)
  })

  it('parentEnds keys every slice by its direct ancestor (roots share a sentinel)', () => {
    // Two depth-0 roots (peers under the track), each with one child.
    // Roots share the root sentinel so they can still merge in the
    // mipmap; descendants store their parent's F32-rounded end so
    // sibling comparisons are byte-identical.
    const child1 = m('c1', 1, 2)
    const child2 = m('c2', 11, 12)
    const p1 = m('p1', 0, 5, [child1])
    const p2 = m('p2', 10, 15, [child2])
    const b = buildSliceBuffers(track([p1, p2]))
    // Pre-order: p1, c1, p2, c2
    expect(Array.from(b.depths)).toEqual([0, 1, 0, 1])
    // Roots share the sentinel (0), so their parentEnds match.
    expect(b.parentEnds[0]).toBe(b.parentEnds[2])
    // Child of p1 keys off p1.end; child of p2 keys off p2.end.
    expect(b.parentEnds[1]).toBe(Math.fround(5))
    expect(b.parentEnds[3]).toBe(Math.fround(15))
    // Different parents ⇒ different keys.
    expect(b.parentEnds[1]).not.toBe(b.parentEnds[3])
  })

  it('sets flags & SLICE_FLAG_COMPACTED iff the source Measure carries compaction reports', () => {
    const compactionReport: CompactionReport = {
      origin: 'subpixel-subtree',
      category: 'js',
      names: ['frame0'],
      count: 99,
      firstTs: 0,
      lastTs: 0.01,
      totalDurationMs: 0.01,
      maxDepthFolded: 99,
    }
    const folded: Measure = {
      id: 'folded',
      name: 'folded',
      start: 0,
      end: 0.01,
      events: [],
      marks: [],
      measures: [],
      compaction: [compactionReport],
    }
    const plain = m('plain', 1, 2)
    const b = buildSliceBuffers(track([folded, plain]))

    expect(b.count).toBe(2)
    expect(b.flags[0] & SLICE_FLAG_COMPACTED).toBe(SLICE_FLAG_COMPACTED)
    expect(b.flags[1] & SLICE_FLAG_COMPACTED).toBe(0)
  })

  it('mipmap merges OR every contributing flag bit into the bucket', () => {
    // Build a long row of sub-resolution children so the mipmap's
    // finest level merges them into a single bucket. Two of them
    // carry compaction reports — the bucket must inherit the flag.
    const compactionReport: CompactionReport = {
      origin: 'subpixel-subtree',
      category: 'js',
      names: ['frame0'],
      count: 50,
      firstTs: 0,
      lastTs: 0,
      totalDurationMs: 0,
      maxDepthFolded: 50,
    }
    const children: Measure[] = []
    for (let i = 0; i < 50; i++) {
      const ms: Measure = {
        id: `c${i}`,
        name: `c${i}`,
        start: i * 0.05,
        end: i * 0.05 + 0.02,
        events: [],
        marks: [],
        measures: [],
      }
      // Mark a couple of them as compaction representatives.
      if (i === 5 || i === 17) ms.compaction = [compactionReport]
      children.push(ms)
    }
    const root = m('root', 0, 5, children)
    const base = buildSliceBuffers(track([root]))

    // Pre-flight: at least two base slices have the flag set.
    let baseCompactedCount = 0
    for (let i = 0; i < base.count; i++) {
      if (base.flags[i] & SLICE_FLAG_COMPACTED) baseCompactedCount += 1
    }
    expect(baseCompactedCount).toBe(2)

    const mm = buildSliceMipmap(base)
    expect(mm.levels.length).toBeGreaterThan(0)

    // At every level: a bucket has the flag iff at least one source
    // base slice in its window had the flag — i.e. the count of
    // flagged buckets is non-zero whenever we still have at least
    // one bucket that covers the [5, 18] index range, which holds
    // for every level since we never collapse all 50 children to
    // zero buckets.
    for (const lvl of mm.levels) {
      let flaggedBuckets = 0
      for (let i = 0; i < lvl.count; i++) {
        if (lvl.flags[i] & SLICE_FLAG_COMPACTED) flaggedBuckets += 1
      }
      expect(flaggedBuckets).toBeGreaterThan(0)
    }
  })

  it('mipmap leaves bucket flags unset when no source slice was compacted', () => {
    const children: Measure[] = []
    for (let i = 0; i < 50; i++) {
      children.push(m(`c${i}`, i * 0.05, i * 0.05 + 0.02))
    }
    const root = m('root', 0, 5, children)
    const base = buildSliceBuffers(track([root]))
    const mm = buildSliceMipmap(base)
    expect(mm.levels.length).toBeGreaterThan(0)
    for (const lvl of mm.levels) {
      for (let i = 0; i < lvl.count; i++) {
        expect(lvl.flags[i] & SLICE_FLAG_COMPACTED).toBe(0)
      }
    }
  })
})

describe('buildMarkBuffers', () => {
  it('collects nested marks and sorts them by time', () => {
    const nested = m('nest', 5, 20)
    nested.marks.push(mark('m-inner', 7))
    const root = track(
      [m('r', 0, 100, [nested])],
      [mark('m-root-late', 50), mark('m-root-early', 1)],
    )
    const b = buildMarkBuffers(root)
    expect(b.count).toBe(3)
    expect(Array.from(b.times)).toEqual([1, 7, 50])
    expect(b.marks.map(x => x.id)).toEqual(['m-root-early', 'm-inner', 'm-root-late'])
  })

  it('packs default mark color when none is provided', () => {
    const b = buildMarkBuffers(track([], [mark('m1', 0)]))
    expect(b.colors[0] >>> 0).toBe(DEFAULT_MARK_COLOR >>> 0)
  })
})

describe('lowerBoundF32', () => {
  const arr = new Float32Array([0, 1, 5, 5, 10])

  it('returns 0 below all', () => {
    expect(lowerBoundF32(arr, arr.length, -5)).toBe(0)
  })
  it('returns count above all', () => {
    expect(lowerBoundF32(arr, arr.length, 100)).toBe(arr.length)
  })
  it('returns the first index whose value >= target', () => {
    expect(lowerBoundF32(arr, arr.length, 5)).toBe(2)
    expect(lowerBoundF32(arr, arr.length, 4)).toBe(2)
    expect(lowerBoundF32(arr, arr.length, 6)).toBe(4)
  })
})
