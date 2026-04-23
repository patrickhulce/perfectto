import type {Measure, Timeline, Track} from '../core'
import {
  parseTimelineUrlParams,
  resolveInitialSelection,
} from '../components/timeline/urlParams'
import {buildSliceBuffers} from '../core/render/sliceBuffers'

function m(
  id: string,
  start: number,
  end: number,
  children: Measure[] = [],
): Measure {
  return {id, name: id, start, end, events: [], marks: [], measures: children}
}

function track(id: string, measures: Measure[]): Track {
  return {id, name: id, marks: [], measures, buffers: buildSliceBuffers({marks: [], measures})}
}

function timeline(tracks: Track[]): Timeline {
  return {
    start: 0,
    end: 1000,
    systems: [{id: 'sys', name: 'sys', tracks}],
  }
}

describe('parseTimelineUrlParams', () => {
  it('returns nulls for an empty search string', () => {
    const out = parseTimelineUrlParams('')
    expect(out.view).toBeNull()
    expect(out.selection).toBeNull()
  })

  it('parses a view range', () => {
    const out = parseTimelineUrlParams(
      '?view%5BstartMs%5D=477.5&view%5BendMs%5D=479.6',
    )
    expect(out.view).toEqual({startMs: 477.5, endMs: 479.6})
  })

  it('parses a view range with literal bracket characters', () => {
    const out = parseTimelineUrlParams('?view[startMs]=100&view[endMs]=200')
    expect(out.view).toEqual({startMs: 100, endMs: 200})
  })

  it('drops invalid view ranges silently', () => {
    expect(parseTimelineUrlParams('?view[startMs]=10&view[endMs]=10').view).toBeNull()
    expect(parseTimelineUrlParams('?view[startMs]=20&view[endMs]=10').view).toBeNull()
    expect(parseTimelineUrlParams('?view[startMs]=foo&view[endMs]=10').view).toBeNull()
    expect(parseTimelineUrlParams('?view[startMs]=10').view).toBeNull()
  })

  it('parses a minimal selection (start/end only)', () => {
    const out = parseTimelineUrlParams(
      '?selection[startMs]=477.942&selection[endMs]=479.216',
    )
    expect(out.selection).toEqual({
      startMs: 477.942,
      endMs: 479.216,
      trackId: undefined,
      depth: undefined,
      name: undefined,
    })
  })

  it('parses a fully-qualified selection with trackId, depth and name', () => {
    const out = parseTimelineUrlParams(
      '?selection[startMs]=100&selection[endMs]=200&selection[trackId]=main&selection[depth]=3&selection[name]=FunctionCall',
    )
    expect(out.selection).toEqual({
      startMs: 100,
      endMs: 200,
      trackId: 'main',
      depth: 3,
      name: 'FunctionCall',
    })
  })

  it('combines view and selection in one URL', () => {
    const out = parseTimelineUrlParams(
      '?view[startMs]=0&view[endMs]=10&selection[startMs]=2&selection[endMs]=3',
    )
    expect(out.view).toEqual({startMs: 0, endMs: 10})
    expect(
      (out.selection as {startMs: number} | null)?.startMs,
    ).toBe(2)
  })

  it('parses a flat ?selection=<hexId> form', () => {
    const out = parseTimelineUrlParams('?selection=3a7f')
    expect(out.selection).toEqual({id: '3a7f'})
  })

  it('prefers the flat id form over the bracketed bounds form', () => {
    const out = parseTimelineUrlParams(
      '?selection=42&selection[startMs]=100&selection[endMs]=200',
    )
    expect(out.selection).toEqual({id: '42'})
  })

  it('treats an empty ?selection= as absent', () => {
    const out = parseTimelineUrlParams('?selection=')
    expect(out.selection).toBeNull()
  })
})

describe('resolveInitialSelection', () => {
  it('finds a slice by start/end across tracks', () => {
    const tl = timeline([
      track('a', [m('root', 0, 100, [m('child', 10, 20)])]),
      track('b', [m('other', 50, 70)]),
    ])
    const hit = resolveInitialSelection(tl, {startMs: 10, endMs: 20})
    expect(hit).toEqual({
      trackId: 'a',
      startMs: expect.closeTo(10, 3),
      endMs: expect.closeTo(20, 3),
      depth: 1,
    })
  })

  it('restricts to trackId when provided', () => {
    const tl = timeline([
      track('a', [m('x', 50, 60)]),
      track('b', [m('y', 50, 60)]),
    ])
    const hit = resolveInitialSelection(tl, {
      startMs: 50,
      endMs: 60,
      trackId: 'b',
    })
    expect(hit?.trackId).toBe('b')
  })

  it('disambiguates by depth', () => {
    const tl = timeline([
      track('a', [
        m('parent', 0, 100, [m('child', 0, 100)]),
      ]),
    ])
    const shallow = resolveInitialSelection(tl, {startMs: 0, endMs: 100, depth: 0})
    expect(shallow?.depth).toBe(0)
    const deep = resolveInitialSelection(tl, {startMs: 0, endMs: 100, depth: 1})
    expect(deep?.depth).toBe(1)
  })

  it('returns null when no slice matches', () => {
    const tl = timeline([track('a', [m('x', 0, 100)])])
    expect(
      resolveInitialSelection(tl, {startMs: 500, endMs: 600}),
    ).toBeNull()
  })

  it('tolerates ~100us so hand-typed URLs match F32-rounded bounds', () => {
    const tl = timeline([track('a', [m('x', 477.942, 479.216)])])
    const hit = resolveInitialSelection(tl, {
      startMs: 477.95, // 8us off — well within the 100us window
      endMs: 479.2,
    })
    expect(hit).not.toBeNull()
  })

  it('disambiguates by measure name when multiple same-depth neighbours match', () => {
    const tl = timeline([
      track('a', [
        // Two siblings at depth 0 with bounds close enough that the
        // fuzzy ms match would hit either; `name` picks the right one.
        m('FunctionCall', 100, 200),
        m('v8.callFunction', 100.05, 200.05),
      ]),
    ])
    const hit = resolveInitialSelection(tl, {
      startMs: 100,
      endMs: 200,
      name: 'v8.callFunction',
    })
    expect(hit?.startMs).toBeCloseTo(100.05, 2)
  })

  it('resolves a flat id request by walking track buffers', () => {
    const tl = timeline([
      track('a', [m('root', 0, 100, [m('child', 10, 20)])]),
      track('b', [m('other', 50, 70)]),
    ])
    const hit = resolveInitialSelection(tl, {id: 'child'})
    expect(hit).toEqual({
      trackId: 'a',
      startMs: expect.closeTo(10, 3),
      endMs: expect.closeTo(20, 3),
      depth: 1,
    })
  })

  it('returns null when the flat id does not match any measure', () => {
    const tl = timeline([track('a', [m('root', 0, 100)])])
    expect(resolveInitialSelection(tl, {id: 'nope'})).toBeNull()
  })
})
