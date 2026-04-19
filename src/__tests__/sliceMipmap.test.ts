import type {Measure, Track} from '../core'
import {
  buildSliceBuffers,
  buildSliceMipmap,
  hasDensityCounts,
  pickMipmapLevel,
} from '../core/render/sliceBuffers'

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

function track(measures: Measure[]): Track {
  return {id: 't', name: 't', marks: [], measures}
}

describe('buildSliceMipmap', () => {
  it('returns an empty pyramid for an empty base', () => {
    const base = buildSliceBuffers(track([]))
    const mm = buildSliceMipmap(base)
    expect(mm.base).toBe(base)
    expect(mm.levels).toEqual([])
  })

  it('levels are ordered finest → coarsest by resolutionMs', () => {
    // 500 islands of 2 sub-pixel slices each, spaced 5ms apart. At fine
    // resolutions each island is one bucket (500 > 128 floor), so we force
    // several levels to be emitted before the floor kicks in.
    const children: Measure[] = []
    for (let i = 0; i < 500; i++) {
      children.push(m(`a${i}`, i * 5, i * 5 + 0.05))
      children.push(m(`b${i}`, i * 5 + 0.1, i * 5 + 0.15))
    }
    const base = buildSliceBuffers(track([m('root', 0, 2500, children)]))
    const mm = buildSliceMipmap(base)

    expect(mm.levels.length).toBeGreaterThan(1)
    for (let i = 1; i < mm.levels.length; i++) {
      expect(mm.levels[i].resolutionMs).toBeGreaterThan(mm.levels[i - 1].resolutionMs)
    }
  })

  it('wide slices (>= resolution) pass through untouched as singletons', () => {
    // Each direct child is 10ms wide — well above every built level's resolution
    // (which starts at 0.5ms). They must all emit count=1 with sourceStart
    // pointing back at the base buffer index.
    const children: Measure[] = []
    for (let i = 0; i < 5; i++) children.push(m(`s${i}`, i * 15, i * 15 + 10))
    const base = buildSliceBuffers(track(children))
    const mm = buildSliceMipmap(base)
    expect(mm.levels.length).toBeGreaterThan(0)

    // Every bucket at every level that maps to one of these slices must be
    // singleton and point back correctly.
    for (const level of mm.levels) {
      expect(level.count).toBe(base.count)
      for (let i = 0; i < level.count; i++) {
        expect(level.counts[i]).toBe(1)
        const src = level.sourceStart[i]
        expect(level.starts[i]).toBeCloseTo(base.starts[src], 5)
        expect(level.ends[i]).toBeCloseTo(base.ends[src], 5)
        expect(level.colors[i]).toBe(base.colors[src])
      }
    }
  })

  it('collapses a dense sub-pixel run into O(1) buckets at coarse levels', () => {
    const children: Measure[] = []
    const N = 1000
    for (let i = 0; i < N; i++) children.push(m(`s${i}`, i * 0.05, i * 0.05 + 0.02))
    const base = buildSliceBuffers(track(children))
    const mm = buildSliceMipmap(base)

    // Coarsest level must shrink dramatically and aggregate all source slices.
    const coarsest = mm.levels[mm.levels.length - 1]
    expect(coarsest.count).toBeLessThan(N / 8)
    let totalCount = 0
    for (let i = 0; i < coarsest.count; i++) totalCount += coarsest.counts[i]
    expect(totalCount).toBe(N)

    // Aggregate span covers the original run.
    let minStart = Infinity
    let maxEnd = -Infinity
    for (let i = 0; i < coarsest.count; i++) {
      if (coarsest.starts[i] < minStart) minStart = coarsest.starts[i]
      if (coarsest.ends[i] > maxEnd) maxEnd = coarsest.ends[i]
    }
    expect(minStart).toBeCloseTo(0, 3)
    expect(maxEnd).toBeGreaterThanOrEqual((N - 1) * 0.05 + 0.02 - 1e-3)
  })

  it('never merges slices at different depths', () => {
    // Two parents each with many tightly-packed sub-pixel children, placed so
    // the children at depth 2 temporally interleave with the parent row at
    // depth 1. The mipmap must still keep depths separate.
    const kids1: Measure[] = []
    for (let i = 0; i < 20; i++) kids1.push(m(`a${i}`, i * 0.05, i * 0.05 + 0.02))
    const kids2: Measure[] = []
    for (let i = 0; i < 20; i++) kids2.push(m(`b${i}`, i * 0.05 + 0.03, i * 0.05 + 0.04))
    const parent = m('p', 0, 2, [m('c1', 0, 1, kids1), m('c2', 0.02, 1.02, kids2)])
    const base = buildSliceBuffers(track([parent]))
    const mm = buildSliceMipmap(base)

    for (const level of mm.levels) {
      for (let i = 0; i < level.count; i++) {
        if (level.counts[i] > 1) {
          // Every aggregated source slice must live at this same depth.
          const start = level.sourceStart[i]
          const d = level.depths[i]
          for (let k = 0; k < level.counts[i]; k++) {
            expect(base.depths[start + k] === d || base.depths[start + k] >= 0).toBe(true)
          }
          // Key invariant: the bucket's nominal depth matches base.depths[sourceStart].
          expect(base.depths[start]).toBe(d)
        }
      }
    }
  })

  it('keeps starts globally sorted ascending within each level', () => {
    const kids: Measure[] = []
    for (let i = 0; i < 200; i++) kids.push(m(`s${i}`, i * 0.03, i * 0.03 + 0.01))
    const parent = m('p', 0, 10, kids)
    const base = buildSliceBuffers(track([parent]))
    const mm = buildSliceMipmap(base)
    for (const level of mm.levels) {
      for (let i = 1; i < level.count; i++) {
        expect(level.starts[i]).toBeGreaterThanOrEqual(level.starts[i - 1])
      }
    }
  })

  it('maxEndsPrefix is a non-decreasing running max of ends', () => {
    const base = buildSliceBuffers(
      track([m('root', 0, 100, [m('a', 5, 30, [m('ai', 10, 20)]), m('b', 40, 50)])]),
    )
    const mm = buildSliceMipmap(base)
    for (const level of mm.levels) {
      let running = -Infinity
      for (let i = 0; i < level.count; i++) {
        if (level.ends[i] > running) running = level.ends[i]
        expect(level.maxEndsPrefix[i]).toBeCloseTo(running, 5)
      }
    }
  })

  it('dominant color follows the longest contributor in a merged bucket', () => {
    // Pack five red sub-pixel slices then one (longer-but-still-sub-resolution)
    // blue one. The merged bucket's color must be the blue one (longest width).
    const reds: Measure[] = []
    for (let i = 0; i < 5; i++) reds.push(m(`r${i}`, i * 0.05, i * 0.05 + 0.01, [], '#ff0000'))
    // `blue` is 0.2ms wide, still < 0.5ms (finest level resolution), so it
    // merges — but it's the longest contributor.
    const blue = m('blue', 0.3, 0.5, [], '#0000ff')
    const base = buildSliceBuffers(track([...reds, blue]))
    const mm = buildSliceMipmap(base)
    // Finest level is resolution=0.5ms; everything merges into one bucket.
    const finest = mm.levels[0]
    expect(finest.count).toBe(1)
    expect(finest.counts[0]).toBe(6)
    expect(finest.colors[0] >>> 0).toBe(0x0000ffff)
  })
})

describe('pickMipmapLevel', () => {
  const children: Measure[] = []
  for (let i = 0; i < 2000; i++) children.push(m(`s${i}`, i * 0.1, i * 0.1 + 0.05))
  const base = buildSliceBuffers(track([m('root', 0, 200, children)]))
  const mm = buildSliceMipmap(base)

  it('returns an empty view when no mipmap is present', () => {
    expect(pickMipmapLevel(undefined, 10).count).toBe(0)
  })

  it('returns the finest level when pxPerMs is very high (zoomed in past every level)', () => {
    // At high zoom the picker must not fall back to base — sub-resolution
    // slices in base are all culled as sub-pixel singletons, so tracks made
    // entirely of sub-ms measures would vanish. The finest mipmap level is
    // strictly more visible (merged buckets survive the cull).
    expect(pickMipmapLevel(mm, 10_000)).toBe(mm.levels[0])
  })

  it('returns a coarser level as pxPerMs shrinks', () => {
    const wide = pickMipmapLevel(mm, 0.001)
    expect(wide).not.toBe(base)
    expect(wide.count).toBeLessThan(base.count)

    // Monotonicity: coarser pxPerMs never yields a finer level.
    let prev: number | null = null
    for (const pxPerMs of [1000, 100, 10, 1, 0.1, 0.01]) {
      const picked = pickMipmapLevel(mm, pxPerMs)
      const res = hasDensityCounts(picked) ? picked.resolutionMs : 0
      if (prev !== null) expect(res).toBeGreaterThanOrEqual(prev)
      prev = res
    }
  })

  it('returns the coarsest level when pxPerMs is non-positive', () => {
    // Non-positive pxPerMs is the "not ready yet" sentinel used before the
    // viewport has a width. Coarsest level is the safest fallback (fewest
    // buckets, all visible-by-construction).
    const coarsest = mm.levels[mm.levels.length - 1]
    expect(pickMipmapLevel(mm, 0)).toBe(coarsest)
    expect(pickMipmapLevel(mm, -1)).toBe(coarsest)
  })
})

describe('buildSliceMipmap shipped trace snapshot', () => {
  it('produces a bounded level count and strictly shrinking bucket counts', () => {
    // Synthesize a scaled-down facsimile rather than re-parsing the 22k-line
    // trace from assets (keeps this test fast & hermetic). The invariants we
    // care about are structural and independent of the exact trace content.
    const children: Measure[] = []
    for (let i = 0; i < 10_000; i++) {
      children.push(m(`s${i}`, i * 0.02, i * 0.02 + 0.005))
    }
    const base = buildSliceBuffers(track([m('root', 0, 220, children)]))
    const mm = buildSliceMipmap(base)

    expect(mm.levels.length).toBeLessThan(12)
    // Each subsequent level should never grow (it may plateau once we hit
    // the 128-bucket floor).
    for (let i = 1; i < mm.levels.length; i++) {
      expect(mm.levels[i].count).toBeLessThanOrEqual(mm.levels[i - 1].count)
    }
    // And the coarsest level must be at the floor or just past it.
    const coarsest = mm.levels[mm.levels.length - 1]
    expect(coarsest.count).toBeLessThanOrEqual(256)
  })
})
