import {
  DEFAULT_CPU_TINY_OPTIONS,
  DEFAULT_SIBLING_COMPACTION_OPTIONS,
  compactCpuTinyFrames,
  compactSiblings,
  emptyCompactionCounters,
} from '../core/parsers/compaction'
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

function makeContainer(measures: Measure[]): TimelineContainer {
  return {marks: [], measures, maxEnd: measures.at(-1)?.end}
}

let _idCounter = 0
const mintId = (): string => `gen-${_idCounter++}`

beforeEach(() => {
  _idCounter = 0
})

describe('compactSiblings', () => {
  it('never folds same-name parents that carry nested children', () => {
    // Models the real-trace regression: 200 adjacent RunTask parents,
    // each wrapping a nested subtree. Folding any of them would silently
    // delete the inner structure from the flame chart.
    const measures: Measure[] = []
    for (let i = 0; i < 200; i++) {
      const s = i * 10
      measures.push(
        parent(`run-${i}`, 'RunTask', s, s + 9, [
          leaf(`inner-${i}`, 'DoWork', s + 1, s + 8, 'js'),
        ]),
      )
    }
    const container = makeContainer(measures)
    const counters = emptyCompactionCounters()

    compactSiblings(
      container,
      DEFAULT_SIBLING_COMPACTION_OPTIONS,
      mintId,
      counters,
      container.maxEnd!,
    )

    expect(container.measures).toHaveLength(200)
    expect(counters.siblingRunsFolded).toBe(0)
    expect(counters.siblingEventsFolded).toBe(0)
    // Each parent still carries its nested child — the whole point of
    // not folding parents.
    expect(container.measures.every(m => m.measures.length === 1)).toBe(true)
  })

  it('folds a long run of tiny leaf siblings', () => {
    const measures: Measure[] = []
    for (let i = 0; i < 50; i++) {
      const s = i * 0.01
      measures.push(leaf(`tick-${i}`, 'Tick', s, s + 0.008))
    }
    const container = makeContainer(measures)
    const counters = emptyCompactionCounters()

    compactSiblings(
      container,
      DEFAULT_SIBLING_COMPACTION_OPTIONS,
      mintId,
      counters,
      container.maxEnd!,
    )

    expect(container.measures).toHaveLength(1)
    expect(container.measures[0].compaction?.[0]).toMatchObject({
      origin: 'sibling',
      count: 50,
      names: ['Tick'],
    })
    expect(counters.siblingRunsFolded).toBe(1)
    expect(counters.siblingEventsFolded).toBe(50)
  })

  it('does not fold leaves wider than maxEventDurMs', () => {
    // 200 adjacent same-name leaves, each 5ms wide. Individually these
    // are visually meaningful rects; the compactor should leave them.
    const measures: Measure[] = []
    for (let i = 0; i < 200; i++) {
      const s = i * 10
      measures.push(leaf(`big-${i}`, 'BigTask', s, s + 5))
    }
    const container = makeContainer(measures)
    const counters = emptyCompactionCounters()

    compactSiblings(
      container,
      DEFAULT_SIBLING_COMPACTION_OPTIONS,
      mintId,
      counters,
      container.maxEnd!,
    )

    expect(container.measures).toHaveLength(200)
    expect(counters.siblingRunsFolded).toBe(0)
  })

  it('folds tiny leaf runs nested inside a structural parent', () => {
    // Parent with many sub-visible leaf children of the same name —
    // the fold should happen *inside* the parent, never replacing it.
    const children: Measure[] = []
    for (let i = 0; i < 40; i++) {
      const s = i * 0.02
      children.push(leaf(`t-${i}`, 'Tick', s, s + 0.01))
    }
    const root = parent('root', 'RunTask', 0, 1, children)
    const container = makeContainer([root])
    const counters = emptyCompactionCounters()

    compactSiblings(
      container,
      DEFAULT_SIBLING_COMPACTION_OPTIONS,
      mintId,
      counters,
      container.maxEnd!,
    )

    expect(container.measures).toHaveLength(1)
    expect(container.measures[0].name).toBe('RunTask')
    expect(container.measures[0].measures).toHaveLength(1)
    expect(container.measures[0].measures[0].compaction?.[0].count).toBe(40)
    expect(counters.siblingRunsFolded).toBe(1)
  })

  it('does not merge across category boundaries', () => {
    const measures: Measure[] = []
    for (let i = 0; i < 10; i++) {
      measures.push(leaf(`a-${i}`, 'Tick', i * 0.01, i * 0.01 + 0.005, 'catA'))
    }
    for (let i = 0; i < 10; i++) {
      const s = 0.2 + i * 0.01
      measures.push(leaf(`b-${i}`, 'Tick', s, s + 0.005, 'catB'))
    }
    const container = makeContainer(measures)
    const counters = emptyCompactionCounters()

    compactSiblings(
      container,
      DEFAULT_SIBLING_COMPACTION_OPTIONS,
      mintId,
      counters,
      container.maxEnd!,
    )

    expect(container.measures).toHaveLength(2)
    expect(container.measures[0].category).toBe('catA')
    expect(container.measures[1].category).toBe('catB')
  })

  it('preserves a tiny same-name leaf run inside a wide structural parent', () => {
    // Mixed shape: a wide structural `RunTask` sibling next to a
    // dense run of tiny `Tick` leaves. Only the tiny leaves should
    // fold; the wide parent and its child must stay intact.
    const measures: Measure[] = [
      parent('wide', 'RunTask', 0, 100, [
        leaf('inner', 'DoWork', 1, 90, 'js'),
      ]),
    ]
    for (let i = 0; i < 30; i++) {
      const s = 100 + i * 0.01
      measures.push(leaf(`t-${i}`, 'Tick', s, s + 0.005))
    }
    const container = makeContainer(measures)
    const counters = emptyCompactionCounters()

    compactSiblings(
      container,
      DEFAULT_SIBLING_COMPACTION_OPTIONS,
      mintId,
      counters,
      container.maxEnd!,
    )

    expect(container.measures[0].name).toBe('RunTask')
    expect(container.measures[0].measures).toHaveLength(1)
    const folded = container.measures.slice(1)
    expect(folded).toHaveLength(1)
    expect(folded[0].compaction?.[0].count).toBe(30)
    expect(counters.siblingRunsFolded).toBe(1)
  })

  it('leaves runs shorter than minRunLength alone', () => {
    const measures: Measure[] = []
    for (let i = 0; i < 4; i++) {
      measures.push(leaf(`t-${i}`, 'Tick', i * 0.1, i * 0.1 + 0.05))
    }
    const container = makeContainer(measures)
    const counters = emptyCompactionCounters()

    compactSiblings(
      container,
      DEFAULT_SIBLING_COMPACTION_OPTIONS,
      mintId,
      counters,
      container.maxEnd!,
    )

    expect(container.measures).toHaveLength(4)
    expect(counters.siblingRunsFolded).toBe(0)
  })
})

describe('compactCpuTinyFrames', () => {
  function jsFrame(
    id: string,
    name: string,
    start: number,
    end: number,
    children: Measure[] = [],
  ): Measure {
    return {
      id,
      name,
      start,
      end,
      category: 'jsFrame',
      events: [],
      marks: [],
      measures: children,
    }
  }

  it('folds a long run of sub-tinyFrameMs leaf siblings under a parent', () => {
    const tinies: Measure[] = []
    for (let i = 0; i < 32; i++) {
      const s = i * 0.05
      tinies.push(jsFrame(`t-${i}`, `tickFn${i % 4}`, s, s + 0.04))
    }
    const root = jsFrame('root', 'render', 0, 2, tinies)
    const counters = emptyCompactionCounters()

    compactCpuTinyFrames(root, DEFAULT_CPU_TINY_OPTIONS, mintId, counters)

    expect(root.measures).toHaveLength(1)
    expect(root.measures[0].compaction?.[0]).toMatchObject({
      origin: 'cpu-tiny-frames',
      count: 32,
    })
    expect(counters.cpuTinyRunsFolded).toBe(1)
  })

  it('never folds a tiny jsFrame that has its own children', () => {
    // 16 sub-tinyFrameMs jsFrame siblings — but each is itself a
    // structural parent with one child. Folding any of them would
    // throw away those children.
    const siblings: Measure[] = []
    for (let i = 0; i < 16; i++) {
      const s = i * 0.05
      siblings.push(
        jsFrame(`s-${i}`, 'parentFn', s, s + 0.04, [
          jsFrame(`c-${i}`, 'innerFn', s + 0.005, s + 0.03),
        ]),
      )
    }
    const root = jsFrame('root', 'render', 0, 1, siblings)
    const counters = emptyCompactionCounters()

    compactCpuTinyFrames(root, DEFAULT_CPU_TINY_OPTIONS, mintId, counters)

    expect(root.measures).toHaveLength(16)
    // Every parent retains its single child after the bottom-up pass.
    expect(root.measures.every(m => m.measures.length === 1)).toBe(true)
    expect(counters.cpuTinyRunsFolded).toBe(0)
  })

  it('ignores subtrees rooted outside the jsFrame category', () => {
    const root: Measure = {
      id: 'native-root',
      name: 'native',
      start: 0,
      end: 1,
      category: 'native',
      events: [],
      marks: [],
      measures: [],
    }
    for (let i = 0; i < 32; i++) {
      const s = i * 0.05
      root.measures.push(jsFrame(`t-${i}`, 'leaf', s, s + 0.04))
    }
    const counters = emptyCompactionCounters()

    compactCpuTinyFrames(root, DEFAULT_CPU_TINY_OPTIONS, mintId, counters)

    expect(root.measures).toHaveLength(32)
    expect(counters.cpuTinyRunsFolded).toBe(0)
  })
})
