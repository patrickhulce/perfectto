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

/**
 * Sum of "events represented" across a container. Every visible
 * Measure counts as 1 event; a Measure that carries one or more
 * `compaction[]` reports stands in for `1 + Σ count` events because
 * the report's `count` excludes the surviving representative itself.
 *
 * This is the post-cull invariant: it must equal the pre-cull
 * descendant total (parent + every descendant) for any subtree.
 * Tracking it makes "we accidentally lost an entire deep system"
 * regressions impossible to ship — the assertion can't pass unless
 * the cull genuinely accounted for every dropped node.
 */
function eventsRepresented(c: TimelineContainer): number {
  let total = 0
  const stack: TimelineContainer[] = [c]
  while (stack.length > 0) {
    const cur = stack.pop()!
    for (const m of cur.measures) {
      let folded = 0
      if (m.compaction) {
        for (const r of m.compaction) folded += r.count
      }
      total += 1 + folded
      if (m.measures.length > 0) stack.push(m)
    }
  }
  return total
}

/**
 * Total Measure node count under a container (pre-cull); used to
 * compare against {@link eventsRepresented} after the cull runs.
 */
function totalMeasures(c: TimelineContainer): number {
  let total = 0
  const stack: TimelineContainer[] = [c]
  while (stack.length > 0) {
    const cur = stack.pop()!
    total += cur.measures.length
    for (const m of cur.measures) {
      if (m.measures.length > 0) stack.push(m)
    }
  }
  return total
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

  it('mints a fresh id for every synthesized Measure so SliceBuffers stay keyed', () => {
    // Two independent sub-pixel subtrees laid out at non-overlapping
    // ranges. They'll both fold AND coalesce into one blanket rep —
    // every synthesized Measure (the two per-subtree fold reps and
    // the merged blanket) must get its own mintId so canvas hover
    // indexing never collides.
    const issued: string[] = []
    const trackingMint = (): string => {
      const id = `gen-${issued.length}`
      issued.push(id)
      return id
    }
    const a = chain('a', 5, 0, 0.005)
    const b = chain('b', 5, 1, 1.005)
    const container = makeContainer([a, b])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(
      container,
      DEFAULT_SUBPIXEL_CULL_OPTIONS,
      trackingMint,
      counters,
    )

    expect(counters.subpixelSubtreesFolded).toBe(2)
    // Two per-subtree folds + one blanket-merge synthesized rep.
    expect(issued).toHaveLength(3)
    expect(new Set(issued).size).toBe(3)
    // The visible result is the single merged blanket carrying a
    // fresh id — the per-subtree ids were absorbed by the merge.
    expect(container.measures).toHaveLength(1)
    expect(issued).toContain(container.measures[0].id)
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

  it('preserves the total event count (eventsRepresented invariant)', () => {
    // Any cull, of any shape, must leave `eventsRepresented` equal to
    // the pre-cull node count. The fixtures here cover the full range:
    // - a single chain that gets folded (deep subpixel)
    // - a deep stack that is left intact (visible duration)
    // - a long parent containing a sub-pixel pocket
    // - two independent pockets folded separately
    // - a solitary sub-pixel leaf the gate refuses to fold
    const fixtures: Array<{name: string; build: () => TimelineContainer}> = [
      {
        name: 'deep subpixel',
        build: () => makeContainer([chain('deep', 100, 1, 1.01)]),
      },
      {
        name: 'visible deep stack',
        build: () => makeContainer([chain('tall', 100, 0, 100)]),
      },
      {
        name: 'subpixel pocket inside long parent',
        build: () =>
          makeContainer([
            parent('long-root', 'top', 0, 100, [
              parent('long-child', 'midframe', 0, 50, [chain('tiny', 50, 5, 5.005)]),
            ]),
          ]),
      },
      {
        name: 'two independent subpixel pockets',
        build: () => makeContainer([chain('a', 5, 0, 0.005), chain('b', 5, 1, 1.005)]),
      },
      {
        name: 'solitary subpixel leaf',
        build: () => makeContainer([leaf('lone', 'tinyleaf', 0, 0.01)]),
      },
    ]

    for (const fx of fixtures) {
      const container = fx.build()
      const before = totalMeasures(container)
      const counters = emptyCompactionCounters()
      cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)
      const after = eventsRepresented(container)
      expect({fixture: fx.name, before, after}).toEqual({
        fixture: fx.name,
        before,
        after: before,
      })
    }
  })

  it('coalesces adjacent subpixel-subtree folds into one wide blanket rep', () => {
    // Three independent subpixel subtrees laid out in a row inside a
    // single parent — exactly the screenshot pattern: a wide parent
    // with many tiny folded grandchildren that each render as 0.02ms
    // slivers. The blanket merge should produce ONE wide rep spanning
    // the whole run with a generic "{N} folded subtrees" label.
    const fixA = chain('a', 5, 0, 0.005)
    const fixB = chain('b', 5, 0.01, 0.015)
    const fixC = chain('c', 5, 0.02, 0.025)
    const wideParent = parent('wide', 'parent', 0, 100, [fixA, fixB, fixC])
    const container = makeContainer([wideParent])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    expect(container.measures).toHaveLength(1)
    const top = container.measures[0]
    // Wide parent stays — it's well above threshold — and its three
    // sub-pixel children collapse into one blanket rep.
    expect(top.measures).toHaveLength(1)
    const blanket = top.measures[0]
    expect(blanket.measures).toHaveLength(0)
    expect(blanket.start).toBe(0)
    expect(blanket.end).toBe(0.025)
    expect(blanket.name).toBe('3 folded subtrees')
    const report = blanket.compaction![0]
    expect(report.origin).toBe('subpixel-subtree')
    expect(report.subtreesMerged).toBe(3)
    // Three 5-deep chains = 15 source events. Per the merge contract,
    // 1 + report.count === total source events (so eventsRepresented
    // sees 15). 15 - 1 = 14.
    expect(report.count).toBe(14)
    // Counters still tally per-fold work, not per-merge — three
    // subtrees were folded.
    expect(counters.subpixelSubtreesFolded).toBe(3)
    expect(counters.subpixelEventsFolded).toBe(12) // 4 descendants × 3 chains
  })

  it('blanket merge ranks names by aggregate duration', () => {
    // Two subtrees folded under one parent. Each chain frame names
    // are unique (frame0..frame4), but in chain N the deepest leaf
    // covers the full range while ancestors are 0-duration siblings —
    // doesn't matter for the test, what matters is determinism: the
    // top names must come out sorted by aggregate duration desc.
    const fixA = chain('a', 5, 0, 0.005) // names frame0..frame4
    const fixB = chain('b', 5, 0.01, 0.015) // names frame0..frame4 (same)
    const wideParent = parent('wide', 'parent', 0, 100, [fixA, fixB])
    const container = makeContainer([wideParent])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    const blanket = container.measures[0].measures[0]
    const report = blanket.compaction![0]
    expect(report.names.length).toBeGreaterThan(0)
    expect(report.nameDurationsMs).toBeDefined()
    expect(report.nameDurationsMs!.length).toBe(report.names.length)
    // Strictly non-increasing — the rank-by-duration contract.
    for (let i = 1; i < report.nameDurationsMs!.length; i++) {
      expect(report.nameDurationsMs![i]).toBeLessThanOrEqual(
        report.nameDurationsMs![i - 1],
      )
    }
  })

  it('leaves a single subpixel fold untouched (no run to coalesce)', () => {
    // Only ONE subpixel-fold candidate inside the wide parent — there's
    // nothing to coalesce, so the rep keeps its original name and
    // bounds rather than getting renamed to "1 folded subtrees".
    const fix = chain('only', 5, 0, 0.005)
    const wideParent = parent('wide', 'parent', 0, 100, [fix])
    const container = makeContainer([wideParent])
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    const top = container.measures[0]
    expect(top.measures).toHaveLength(1)
    const folded = top.measures[0]
    // Original chain root name (frame0) survives — no blanket label.
    expect(folded.name).toBe('frame0')
    expect(folded.compaction![0].subtreesMerged).toBeUndefined()
  })

  it('blanket merge preserves the eventsRepresented invariant', () => {
    // Specifically targets the merged-rep accounting: the "1 + count"
    // formula in eventsRepresented must still equal pre-cull node count.
    const fixA = chain('a', 5, 0, 0.005)
    const fixB = chain('b', 5, 0.01, 0.015)
    const fixC = chain('c', 5, 0.02, 0.025)
    const wideParent = parent('wide', 'parent', 0, 100, [fixA, fixB, fixC])
    const container = makeContainer([wideParent])
    const before = totalMeasures(container)
    const counters = emptyCompactionCounters()

    cullSubpixelSubtrees(container, DEFAULT_SUBPIXEL_CULL_OPTIONS, mintId, counters)

    expect(eventsRepresented(container)).toBe(before)
  })

  // ----------------------------------------------------------------
  // Regression: "the bottom rect after __call__ should be a striped
  // wide rect". Captured failures from the user's flame-chart
  // screenshot. They mirror real Chrome traces where a wide call
  // chain descends into one (or more) subpixel-only subtrees and the
  // user expects a visible striped marker — *not* a 0.02 ms sliver
  // they can't even see — at the spot where detail was hidden.
  // ----------------------------------------------------------------

  /**
   * Walk every Measure in `c` and yield only the subpixel-fold reps
   * (those carrying a `subpixel-subtree` compaction report). Used by
   * the regression checks below to find the synthesized fold reps
   * without depending on tree shape — the exact depth at which the
   * fold lands shouldn't matter, only that it's wide enough to see.
   */
  function collectSubpixelFolds(c: TimelineContainer): Measure[] {
    const out: Measure[] = []
    const stack: TimelineContainer[] = [c]
    while (stack.length > 0) {
      const cur = stack.pop()!
      for (const m of cur.measures) {
        if (m.compaction?.some(r => r.origin === 'subpixel-subtree')) {
          out.push(m)
        }
        if (m.measures.length > 0) stack.push(m)
      }
    }
    return out
  }

  // NOTE: a previous iteration of this file had four "regression: …"
  // tests asserting that subpixel-fold representatives must occupy a
  // visible fraction of any wide ancestor. Those tests captured a wrong
  // hypothesis — that the cull stage should fabricate a wide rep when
  // its only child is a genuinely tiny subtree. In the real failing
  // trace the *parser* was mis-nesting wide X events under tiny
  // straddled probes, which then made the cull stage do exactly the
  // right thing on a tiny ancestor it never should have been handed.
  // The parser-level fix (and its tests in parser.test.ts) is the
  // proper invariant; see "does not nest a wider X event under a tiny
  // straddled ancestor" for the upstream guard.

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
