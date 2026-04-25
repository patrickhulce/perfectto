import {emptyCompactionCounters} from '../core/parsers/compaction'
import {DEFAULT_SUBPIXEL_CULL_OPTIONS, cullSubpixelSubtrees} from '../core/parsers/cull'
import type {Measure, TimelineContainer} from '../core'

function leaf(
  id: string,
  name: string,
  start: number,
  end: number,
  category = 'cat',
): Measure {
  return {
    id,
    name,
    start,
    end,
    category,
    events: [],
    marks: [],
    measures: [],
  }
}

function parent(
  id: string,
  name: string,
  start: number,
  end: number,
  children: Measure[],
  category = 'cat',
): Measure {
  return {
    id,
    name,
    start,
    end,
    category,
    events: [],
    marks: [],
    measures: children,
  }
}

/**
 * Build a left-leaning chain of `depth` Measures whose root spans
 * `[start, end]` and whose every interior node carries a single child
 * spanning the same range. Mirrors the recursion-tail shape the cull
 * exists to collapse.
 */
function chain(prefix: string, depth: number, start: number, end: number): Measure {
  let cur: Measure = leaf(`${prefix}-${depth - 1}`, `frame${depth - 1}`, start, end)
  for (let i = depth - 2; i >= 0; i--) {
    cur = parent(`${prefix}-${i}`, `frame${i}`, start, end, [cur])
  }
  return cur
}

function makeContainer(measures: Measure[]): TimelineContainer {
  return {marks: [], measures}
}

let _idCounter = 0
const mintId = (): string => `gen-${_idCounter++}`

beforeEach(() => {
  _idCounter = 0
})

describe('cullSubpixelSubtrees', () => {
  it('collapses an entire deep subtree when the root is sub-pixel', () => {
    // 0.01 ms span carrying a 100-deep stack — the user's failing
    // trace pattern in miniature. Cull must replace the whole thing
    // with one synthetic Measure rather than preserve the skeleton.
    const root = chain('deep', 100, 1, 1.01)
    const container = makeContainer([root])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    expect(container.measures).toHaveLength(1)
    const folded = container.measures[0]
    expect(folded.measures).toHaveLength(0)
    expect(folded.start).toBe(1)
    expect(folded.end).toBe(1.01)
    expect(folded.compaction).toHaveLength(1)
    const report = folded.compaction![0]
    expect(report.origin).toBe('subpixel-subtree')
    // 100 nodes, root excluded → 99 descendants folded.
    expect(report.count).toBe(99)
    expect(report.maxDepthFolded).toBe(99)
    expect(counters.subpixelSubtreesFolded).toBe(1)
    expect(counters.subpixelEventsFolded).toBe(99)
    expect(counters.subpixelMaxDepthFolded).toBe(99)
  })

  it('does not recurse into a folded subtree', () => {
    // Verifies the "highest possible point" guarantee: even if a
    // sub-pixel parent contains a longer-than-threshold child (which
    // can happen on synthetic inputs and is impossible to render by
    // construction), the parent is still folded as one and we don't
    // double-fold the descendants. The synthesized representative
    // carries the parent's bounds verbatim.
    const inner = leaf('inner', 'long', 0, 5) // 5ms, but inside a 0.01ms parent
    const root = parent('outer', 'short', 0, 0.01, [inner])
    const container = makeContainer([root])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    expect(container.measures).toHaveLength(1)
    expect(container.measures[0].end).toBe(0.01)
    expect(counters.subpixelSubtreesFolded).toBe(1)
  })

  it('preserves visible-duration deep stacks intact', () => {
    // Same depth as the first test (100), but each frame is 1ms
    // so individual frames are still renderable. The cull must
    // leave them alone — depth alone is not a fold trigger.
    const root = chain('tall', 100, 0, 100)
    const container = makeContainer([root])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    expect(counters.subpixelSubtreesFolded).toBe(0)
    expect(counters.subpixelEventsFolded).toBe(0)
    let depth = 0
    let cur: Measure | undefined = container.measures[0]
    while (cur && cur.measures.length > 0) {
      depth += 1
      cur = cur.measures[0]
    }
    expect(depth).toBe(99)
  })

  it('catches sub-pixel pockets nested inside a long parent', () => {
    // A 100ms parent with a 0.005ms sub-pixel grandchild buried
    // inside. Cull descends past the long parent (it's clearly
    // above threshold) but folds the deep pocket once it finds it.
    const tinyRoot = chain('tiny', 50, 5, 5.005)
    const longChild = parent('long-child', 'midframe', 0, 50, [tinyRoot])
    const longRoot = parent('long-root', 'top', 0, 100, [longChild])
    const container = makeContainer([longRoot])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    expect(counters.subpixelSubtreesFolded).toBe(1)
    expect(counters.subpixelEventsFolded).toBe(49)
    // Walk to the folded representative; everything above it stays
    // structural.
    const top = container.measures[0]
    expect(top.measures).toHaveLength(1)
    const mid = top.measures[0]
    expect(mid.measures).toHaveLength(1)
    const folded = mid.measures[0]
    expect(folded.measures).toHaveLength(0)
    expect(folded.compaction?.[0].origin).toBe('subpixel-subtree')
  })

  it('uses unique mintId for every fold so SliceBuffers stay keyed', () => {
    // Two independent sub-pixel subtrees → two separate folds, with
    // distinct ids. Without unique ids the canvas hover index would
    // collide.
    const a = chain('a', 5, 0, 0.005)
    const b = chain('b', 5, 1, 1.005)
    const container = makeContainer([a, b])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    expect(container.measures).toHaveLength(2)
    expect(container.measures[0].id).not.toBe(container.measures[1].id)
    expect(counters.subpixelSubtreesFolded).toBe(2)
  })

  it('skips solitary leaves (minDescendants gate)', () => {
    // A 0.01ms leaf with no children would produce a useless
    // single-event "fold" — the gate prevents that, leaving the
    // sibling/CPU-tiny passes to handle it.
    const lone = leaf('lone', 'tinyleaf', 0, 0.01)
    const container = makeContainer([lone])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    expect(counters.subpixelSubtreesFolded).toBe(0)
    expect(container.measures[0]).toBe(lone)
  })

  it('survives very deep stacks without blowing the JS call stack', () => {
    // The failing trace tops out at ~1425 deep; we synthesize 5000
    // here so the iterative worklist is exercised well past any
    // reasonable engine recursion limit.
    const root = chain('huge', 5000, 0, 0.001)
    const container = makeContainer([root])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    expect(counters.subpixelSubtreesFolded).toBe(1)
    expect(counters.subpixelMaxDepthFolded).toBe(4999)
  })
})
