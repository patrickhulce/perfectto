import {
  applyPersona,
  BUILTIN_PERSONAS,
  detectPersona,
  findPersona,
  RAW_PERSONA,
  WEB_DEV_PERSONA,
  type Measure,
  type ParsedTrace,
  type Persona,
  type System,
  type Track,
} from '../core'
import {buildSliceBuffers, buildSliceMipmap} from '../core/render/sliceBuffers'
import {DEFAULT_MEASURE_COLOR, packColor} from '../core/render/packColor'
import {buildOverviewBands} from '../core/render/overviewBands'

function m(name: string, start: number, end: number, category?: string): Measure {
  return {
    id: `${name}-${start}`,
    name,
    start,
    end,
    category,
    events: [],
    marks: [],
    measures: [],
  }
}

function makeTrack(
  id: string,
  name: string,
  measures: Measure[],
  category?: string,
): Track {
  const buffers = buildSliceBuffers({marks: [], measures})
  const mipmap = buildSliceMipmap(buffers)
  return {id, name, category, marks: [], measures, buffers, mipmap}
}

function makeSystem(id: string, name: string, tracks: Track[]): System {
  return {id, name, tracks}
}

function makeTrace(systems: System[], start = 0, end = 100): ParsedTrace {
  return {
    source: {name: 'test', size: 0},
    metadata: {},
    timeline: {start, end, systems},
    events: [],
  }
}

describe('persona registry', () => {
  it('includes raw and web-dev built-ins', () => {
    expect(findPersona('raw')).toBe(RAW_PERSONA)
    expect(findPersona('web-dev')).toBe(WEB_DEV_PERSONA)
    expect(findPersona('bogus')).toBeUndefined()
    expect(BUILTIN_PERSONAS).toContain(RAW_PERSONA)
    expect(BUILTIN_PERSONAS).toContain(WEB_DEV_PERSONA)
  })

  it('detects web-dev persona for Chrome-like traces', () => {
    const main = makeTrack('t1', 'CrRendererMain', [m('FunctionCall', 0, 10)])
    const trace = makeTrace([makeSystem('s1', 'Renderer', [main])])
    expect(detectPersona(trace)).toBe(WEB_DEV_PERSONA)
  })

  it('falls back to raw persona for non-Chrome traces', () => {
    const worker = makeTrack('t1', 'WorkerThread', [m('doWork', 0, 10)])
    const trace = makeTrace([makeSystem('s1', 'App', [worker])])
    expect(detectPersona(trace)).toBe(RAW_PERSONA)
  })
})

describe('applyPersona (raw)', () => {
  it('leaves tracks in original order and colors at defaults', () => {
    const t1 = makeTrack('t1', 'Worker', [m('a', 0, 1)])
    const t2 = makeTrack('t2', 'CompositorTileWorker', [m('b', 2, 3)])
    const sys = makeSystem('s1', 'App', [t1, t2])
    const trace = makeTrace([sys])

    const applied = applyPersona(trace, RAW_PERSONA)
    expect(applied.systems).toHaveLength(1)
    expect(applied.systems[0].tracks.map(t => t.id)).toEqual(['t1', 't2'])
    expect(applied.hiddenTracksBySystem).toEqual({})
    expect(applied.bands).toEqual([])
    // Raw has no color rules → every slice falls back to the default.
    expect(t1.buffers!.colors[0]).toBe(DEFAULT_MEASURE_COLOR)
  })
})

describe('applyPersona (web-dev)', () => {
  function buildChromeTrace(): ParsedTrace {
    const rendererMain = makeTrack('tm', 'CrRendererMain', [
      m('FunctionCall', 0, 10),
      m('Layout', 10, 20),
      m('Paint', 20, 30),
      m('ParseHTML', 30, 40),
    ])
    const threadPool = makeTrack('tp', 'ThreadPoolForegroundWorker', [m('Work', 0, 5)])
    const compositor = makeTrack('tc', 'Compositor', [m('CompositeLayers', 40, 50)])
    return makeTrace([
      makeSystem('s1', 'Renderer', [threadPool, rendererMain, compositor]),
    ])
  }

  it('pins CrRendererMain to the top and relabels it "Main"', () => {
    const trace = buildChromeTrace()
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    const tracks = applied.systems[0].tracks
    expect(tracks[0].id).toBe('tm')
    expect(tracks[0].name).toBe('Main')
  })

  it('hides ThreadPool tracks by default', () => {
    const trace = buildChromeTrace()
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    const visibleIds = applied.systems[0].tracks.map(t => t.id)
    expect(visibleIds).not.toContain('tp')
    expect(applied.hiddenTracksBySystem.s1?.map(t => t.id)).toContain('tp')
  })

  it('paints slices with the persona palette', () => {
    const trace = buildChromeTrace()
    applyPersona(trace, WEB_DEV_PERSONA)
    const renderer = trace.timeline.systems[0].tracks.find(t => t.id === 'tm')!
    const buf = renderer.buffers!
    // Uint32Array stores unsigned; `packColor` can return signed for
    // colors whose top byte has the high bit set — coerce to unsigned.
    const u = (n: number): number => n >>> 0
    expect(buf.colors[0]).toBe(u(packColor('#f0c000', DEFAULT_MEASURE_COLOR)))
    expect(buf.colors[1]).toBe(u(packColor('#9a4ca2', DEFAULT_MEASURE_COLOR)))
    expect(buf.colors[2]).toBe(u(packColor('#4e9a06', DEFAULT_MEASURE_COLOR)))
    expect(buf.colors[3]).toBe(u(packColor('#4398f0', DEFAULT_MEASURE_COLOR)))
  })

  it('sets default expand state for the renderer main thread and its system', () => {
    const trace = buildChromeTrace()
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    expect(applied.defaultTrackExpanded.tm).toBe(true)
    expect(applied.defaultTrackExpanded.tc).toBe(false)
    expect(applied.defaultSystemExpanded.s1).toBe(true)
  })

  it('hides swapper / Process 0 systems and surfaces them in hiddenSystems', () => {
    const rendererMain = makeTrack('tm', 'CrRendererMain', [m('FunctionCall', 0, 10)])
    const swapper = makeTrack('tsw', 'swapper', [m('idle', 0, 10)])
    const trace = makeTrace([
      makeSystem('kernel', 'Process 0', [swapper]),
      makeSystem('renderer', 'Renderer', [rendererMain]),
    ])
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    expect(applied.systems.map(s => s.id)).toEqual(['renderer'])
    expect(applied.hiddenSystems.map(s => s.name)).toEqual(['Process 0'])
  })

  it('hides per-process Async tracks via trackCategory rule', () => {
    const rendererMain = makeTrack('tm', 'CrRendererMain', [m('FunctionCall', 0, 10)])
    const asyncTrack = makeTrack('ta', 'Async', [m('op', 0, 10)], 'async')
    const trace = makeTrace([
      makeSystem('s1', 'Renderer', [rendererMain, asyncTrack]),
    ])
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    const visibleIds = applied.systems[0].tracks.map(t => t.id)
    expect(visibleIds).not.toContain('ta')
    expect(applied.hiddenTracksBySystem.s1?.map(t => t.id)).toContain('ta')
  })

  it('collapses unmatched tracks by default (collapse-by-default baseline)', () => {
    const rendererMain = makeTrack('tm', 'CrRendererMain', [m('FunctionCall', 0, 10)])
    const worker = makeTrack('tw', 'SomeWorker', [m('w', 0, 10)])
    const trace = makeTrace([makeSystem('s1', 'Renderer', [rendererMain, worker])])
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    // No TrackRule touches `SomeWorker`, so the persona-wide
    // `defaultTracksExpanded: false` should drive it closed.
    expect(applied.defaultTrackExpanded.tw).toBe(false)
  })

  it('collapses a Browser-only system by default while renderer stays expanded', () => {
    const rendererMain = makeTrack('tm', 'CrRendererMain', [m('FunctionCall', 0, 10)])
    const browserMain = makeTrack('tb', 'CrBrowserMain', [m('Work', 0, 10)])
    const trace = makeTrace([
      makeSystem('renderer', 'Renderer', [rendererMain]),
      makeSystem('browser', 'Browser', [browserMain]),
    ])
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    expect(applied.defaultSystemExpanded.renderer).toBe(true)
    expect(applied.defaultSystemExpanded.browser).toBe(false)
  })

  it('switching personas restores colors deterministically', () => {
    const trace = buildChromeTrace()
    applyPersona(trace, WEB_DEV_PERSONA)
    // Back to raw: slices should reset to the default measure color.
    applyPersona(trace, RAW_PERSONA)
    const renderer = trace.timeline.systems[0].tracks.find(t => t.id === 'tm')!
    for (let i = 0; i < renderer.buffers!.count; i++) {
      expect(renderer.buffers!.colors[i]).toBe(DEFAULT_MEASURE_COLOR)
    }
  })
})

describe('buildOverviewBands', () => {
  it('produces one series per persona band, each summing to ≤ 1', () => {
    const rendererMain = makeTrack('tm', 'CrRendererMain', [
      m('FunctionCall', 0, 25),
      m('Layout', 25, 50),
      m('Paint', 50, 75),
      m('ParseHTML', 75, 100),
    ])
    const trace = makeTrace([makeSystem('s1', 'Renderer', [rendererMain])])
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    const bands = buildOverviewBands(trace.timeline, applied, 32)
    expect(bands.bands).toHaveLength(WEB_DEV_PERSONA.overviewBands.length)
    for (let i = 0; i < bands.bucketCount; i++) {
      let total = 0
      for (const b of bands.bands) total += b.buckets[i]
      expect(total).toBeLessThanOrEqual(1.0001)
    }
  })

  it('ignores categories not mapped to any band', () => {
    const orphan: Persona = {
      id: 'orphan',
      name: 'Orphan',
      description: '',
      match: () => 0,
      categories: [{id: 'orphanCat', label: 'X', color: '#ffffff'}],
      colorRules: [{categoryId: 'orphanCat'}],
      trackRules: [],
      overviewBands: [], // nothing aggregates
    }
    const t = makeTrack('t1', 'w', [m('a', 0, 50)])
    const trace = makeTrace([makeSystem('s1', 'App', [t])])
    const applied = applyPersona(trace, orphan)
    const bands = buildOverviewBands(trace.timeline, applied, 16)
    expect(bands.bands).toHaveLength(0)
  })
})
