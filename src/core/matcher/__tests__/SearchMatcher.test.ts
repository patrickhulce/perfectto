import {SearchMatcher} from '../SearchMatcher'
import type {Measure, ParsedTrace, Track} from '../../types'

function measure(
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
    marks: [],
    measures: children,
    events: [],
  }
}

function trace(
  trackMeasures: Measure[],
  start = 0,
  end = 10_000,
  trackId = 'main',
): ParsedTrace {
  const track: Track = {
    id: trackId,
    name: trackId,
    marks: [],
    measures: trackMeasures,
  }
  return {
    source: {name: 'test', size: 0},
    metadata: {},
    timeline: {
      start,
      end,
      systems: [{id: 'sys', name: 'sys', tracks: [track]}],
    },
  }
}

function traceWithTracks(
  tracks: Array<{id: string; measures: Measure[]}>,
  start = 0,
  end = 10_000,
): ParsedTrace {
  return {
    source: {name: 'test', size: 0},
    metadata: {},
    timeline: {
      start,
      end,
      systems: [
        {
          id: 'sys',
          name: 'sys',
          tracks: tracks.map(t => ({
            id: t.id,
            name: t.id,
            marks: [],
            measures: t.measures,
          })),
        },
      ],
    },
  }
}

describe('SearchMatcher', () => {
  it('matches by exact named tree path first', () => {
    const sourceLeaf = measure('a-leaf', 'Foo', 1200, 1300)
    const targetLeaf = measure('b-leaf', 'Foo', 1210, 1320)
    const matcher = new SearchMatcher(
      trace([measure('a-root', 'Bar', 1000, 2000, [sourceLeaf])]),
      trace([measure('b-root', 'Bar', 1000, 2000, [targetLeaf])]),
    )

    expect(matcher.findMatch(sourceLeaf, 'main')).toMatchObject({
      measure: targetLeaf,
      trackId: 'main',
      heuristic: 'exactTree',
      vicinity: 'absolute',
    })
  })

  it('relaxes names to match shape and similar duration', () => {
    const sourceLeaf = measure('a-leaf', 'Foo', 1200, 1300)
    const shortCandidate = measure('b-short', 'Renamed', 1210, 1220)
    const durationCandidate = measure('b-duration', 'RenamedToo', 1210, 1315)
    const matcher = new SearchMatcher(
      trace([measure('a-root', 'Bar', 1000, 2000, [sourceLeaf])]),
      traceWithTracks([
        {id: 'short', measures: [measure('b-root1', 'OtherRoot', 1000, 2000, [shortCandidate])]},
        {
          id: 'duration',
          measures: [measure('b-root2', 'OtherRoot', 1000, 2000, [durationCandidate])],
        },
      ]),
    )

    expect(matcher.findMatch(sourceLeaf, 'main')).toMatchObject({
      measure: durationCandidate,
      heuristic: 'shapeWithDuration',
    })
  })

  it('falls back to the same global ordinal by name', () => {
    const firstFoo = measure('a-first', 'Foo', 100, 150)
    const sourceLeaf = measure('a-second', 'Foo', 1200, 1300)
    const targetFirstFoo = measure('b-first', 'Foo', 100, 150)
    const targetSecondFoo = measure('b-second', 'Foo', 1210, 1310)
    const matcher = new SearchMatcher(
      trace([firstFoo, measure('a-parent', 'Parent', 1000, 2000, [sourceLeaf])]),
      trace([measure('b-parent', 'DifferentParent', 1000, 2000, [targetFirstFoo, targetSecondFoo])]),
    )

    expect(matcher.findMatch(sourceLeaf, 'main')).toMatchObject({
      measure: targetSecondFoo,
      heuristic: 'nameOnly',
    })
  })

  it('accepts global-relative vicinity when absolute time differs', () => {
    const sourceLeaf = measure('a-leaf', 'Foo', 1000, 1100)
    const targetLeaf = measure('b-leaf', 'Foo', 2000, 2100)
    const matcher = new SearchMatcher(
      trace([sourceLeaf], 0, 10_000),
      trace([targetLeaf], 0, 20_000),
    )

    expect(matcher.findMatch(sourceLeaf, 'main')?.vicinity).toBe('globalRelative')
  })

  it('accepts root-relative vicinity when global time differs', () => {
    const sourceLeaf = measure('a-leaf', 'Foo', 1500, 1600)
    const targetLeaf = measure('b-leaf', 'Foo', 6000, 6100)
    const matcher = new SearchMatcher(
      trace([measure('a-root', 'Bar', 1000, 2000, [sourceLeaf])], 0, 10_000),
      trace([measure('b-root', 'Bar', 5000, 7000, [targetLeaf])], 0, 10_000),
    )

    expect(matcher.findMatch(sourceLeaf, 'main')?.vicinity).toBe('rootRelative')
  })

  it('returns null when no heuristic passes vicinity validation', () => {
    const sourceLeaf = measure('a-leaf', 'Foo', 1000, 1100)
    const targetLeaf = measure('b-leaf', 'Foo', 9000, 9100)
    const matcher = new SearchMatcher(
      trace([sourceLeaf], 0, 10_000),
      trace([targetLeaf], 0, 10_000),
    )

    expect(matcher.findMatch(sourceLeaf, 'main')).toBeNull()
  })
})
