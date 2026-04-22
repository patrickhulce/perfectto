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

  it('scopes overviewSystems to the Main thread (only CrRendererMain is defaultExpanded)', () => {
    // The Chrome fixture has Main + ThreadPool (hidden) + Compositor
    // (visible but defaultExpanded: false). Only Main ends up with
    // defaultTrackExpanded: true, so the overview aggregator should
    // see just that one track — NOT the full visible list, which
    // would drag the Compositor's work into the silhouette.
    const trace = buildChromeTrace()
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    const overviewTrackIds = applied.overviewSystems.flatMap(s => s.tracks.map(t => t.id))
    expect(overviewTrackIds).toEqual(['tm'])
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
    expect(bands.bands).toHaveLength(WEB_DEV_PERSONA.overviewOrder.length)
    for (let i = 0; i < bands.bucketCount; i++) {
      let total = 0
      for (const b of bands.bands) total += b.buckets[i]
      expect(total).toBeLessThanOrEqual(1.0001)
    }
  })

  it('ignores tracks the persona hid so long-lived async slices do not paint a phantom band', () => {
    // Regression: a hidden async track full of loading-categorized
    // slices used to bleed into the overview and paint a persistent
    // blue baseline across the whole trace even after the flame chart
    // had gone quiet. Scoping the aggregator to applied.systems drops
    // those contributions entirely.
    const rendererMain = makeTrack('tm', 'CrRendererMain', [
      m('FunctionCall', 0, 10),
    ])
    const asyncLoading = makeTrack(
      'ta',
      'Async',
      [
        {...m('ResourceReceiveData', 0, 100), category: 'loading,devtools.timeline'},
      ],
      'async',
    )
    const trace = makeTrace([
      makeSystem('s1', 'Renderer', [rendererMain, asyncLoading]),
    ])
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    const bands = buildOverviewBands(trace.timeline, applied, 32)
    const loading = bands.bands.find(b => b.id === 'loading')
    expect(loading).toBeDefined()
    let maxLoading = 0
    for (const v of loading!.buckets) if (v > maxLoading) maxLoading = v
    expect(maxLoading).toBe(0)
  })

  it('attributes nested self-time to each measure\'s own band (not the depth-0 wrapper)', () => {
    // Mirrors the Chrome case: a top-level `RunTask` (system / gray)
    // wraps `EvaluateScript` (scripting / yellow) which wraps user JS
    // (mint, rolled up to scripting). Depth-0-only aggregation used to
    // paint the whole thing gray; self-time aggregation must yield
    // essentially zero system-band contribution (RunTask has no
    // self-time outside its children) and a saturated scripting band.
    // Matches the real chrome parser: synthesized JS frames ship with
    // trace category `jsFrame`, which webDev routes to `userScript`.
    const userJs: Measure = {
      id: 'uj',
      name: 'doWork',
      start: 2,
      end: 98,
      category: 'jsFrame',
      events: [],
      marks: [],
      measures: [],
    }
    const evalScript: Measure = {
      id: 'es',
      name: 'EvaluateScript',
      start: 1,
      end: 99,
      events: [],
      marks: [],
      measures: [userJs],
    }
    const runTask: Measure = {
      id: 'rt',
      name: 'RunTask',
      start: 0,
      end: 100,
      events: [],
      marks: [],
      measures: [evalScript],
    }
    const tm = makeTrack('tm', 'CrRendererMain', [runTask])
    const trace = makeTrace([makeSystem('s1', 'Renderer', [tm])])
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    const result = buildOverviewBands(trace.timeline, applied, 32)
    const byId = (id: string) => result.bands.find(b => b.id === id)!
    const maxOf = (arr: Float32Array): number => {
      let m = 0
      for (const v of arr) if (v > m) m = v
      return m
    }
    const scripting = maxOf(byId('scripting').buckets)
    const system = maxOf(byId('system').buckets)
    // Almost all wall time is scripting (96ms of user JS inside a
    // 98ms EvaluateScript inside a 100ms RunTask) so the scripting
    // silhouette saturates. RunTask's self-time is just the 1ms
    // wrapper gap on each edge — it must stay visibly smaller than
    // the scripting band or we've regressed to depth-0-only counting
    // (which would paint the whole thing system/gray).
    expect(scripting).toBeGreaterThan(0.9)
    expect(system).toBeLessThan(scripting * 0.5)
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
      overviewOrder: [], // nothing aggregates
    }
    const t = makeTrack('t1', 'w', [m('a', 0, 50)])
    const trace = makeTrace([makeSystem('s1', 'App', [t])])
    const applied = applyPersona(trace, orphan)
    const bands = buildOverviewBands(trace.timeline, applied, 16)
    expect(bands.bands).toHaveLength(0)
  })

  it('scopes aggregation to defaultExpanded tracks, ignoring visible-but-collapsed ones', () => {
    // Regression: Web Dev used to wash out because it aggregated every
    // visible track. Here the Compositor track is visible (not hidden
    // by any rule) but starts collapsed, and it's packed with painting
    // slices. The overview must only reflect the Main thread's Layout
    // work — the Compositor's painting stays out entirely.
    const rendererMain = makeTrack('tm', 'CrRendererMain', [
      m('Layout', 0, 50),
    ])
    const compositor = makeTrack('tc', 'Compositor', [
      m('CompositeLayers', 0, 100),
    ])
    const trace = makeTrace([
      makeSystem('s1', 'Renderer', [rendererMain, compositor]),
    ])
    const applied = applyPersona(trace, WEB_DEV_PERSONA)
    // Sanity check: Compositor is in the visible list but NOT in the
    // overview list — the scoping precondition for this test.
    expect(applied.systems[0].tracks.map(t => t.id)).toEqual(
      expect.arrayContaining(['tm', 'tc']),
    )
    expect(applied.overviewSystems.flatMap(s => s.tracks.map(t => t.id))).toEqual(['tm'])

    const bands = buildOverviewBands(trace.timeline, applied, 32)
    const painting = bands.bands.find(b => b.id === 'painting')!
    let maxPainting = 0
    for (const v of painting.buckets) if (v > maxPainting) maxPainting = v
    expect(maxPainting).toBe(0)
    // And the Main thread's Layout work still registers — otherwise
    // we've scoped the overview down to nothing.
    const rendering = bands.bands.find(b => b.id === 'rendering')!
    let maxRendering = 0
    for (const v of rendering.buckets) if (v > maxRendering) maxRendering = v
    expect(maxRendering).toBeGreaterThan(0)
  })

  it('falls back to all visible tracks when no track opts into defaultExpanded', () => {
    // A persona that never flips any track to defaultExpanded: true
    // would otherwise end up with an empty overviewSystems list and
    // an empty overview. The fallback preserves today's behaviour for
    // such personas — the aggregator sees every visible track.
    const open: Persona = {
      id: 'open',
      name: 'Open',
      description: '',
      match: () => 0,
      // No trackRules, no systemRules — nothing flips defaultExpanded.
      categories: [{id: 'x', label: 'X', color: '#abcdef'}],
      colorRules: [{categoryId: 'x'}],
      trackRules: [],
      overviewOrder: ['x'],
    }
    const t1 = makeTrack('t1', 'a', [m('w', 0, 50)])
    const t2 = makeTrack('t2', 'b', [m('w', 0, 50)])
    const trace = makeTrace([makeSystem('s1', 'App', [t1, t2])])
    const applied = applyPersona(trace, open)
    // Fallback: overviewSystems mirrors the full visible list.
    expect(applied.overviewSystems).toBe(applied.systems)
    expect(applied.overviewSystems.flatMap(s => s.tracks.map(t => t.id))).toEqual([
      't1',
      't2',
    ])
  })
})

describe('applyPersona (category hierarchy)', () => {
  it('rolls subcategories into their parent band via parentId', () => {
    const hierarchy: Persona = {
      id: 'hier',
      name: 'Hierarchy',
      description: '',
      match: () => 0,
      categories: [
        {id: 'scripting', label: 'Scripting', color: '#f0c000'},
        {
          id: 'userScript',
          label: 'User JS',
          color: '#8ed9c1',
          parentId: 'scripting',
        },
        // No-band categories — present in the palette but absent from
        // overviewOrder, so they must not appear in bandForCategory.
        {id: 'idle', label: 'Idle', color: '#e5e5e5'},
      ],
      colorRules: [],
      trackRules: [],
      overviewOrder: ['scripting'],
    }
    const trace = makeTrace([makeSystem('s1', 'App', [])])
    const applied = applyPersona(trace, hierarchy)
    // Band list: one entry, rooted at `scripting`.
    expect(applied.bands.map(b => b.id)).toEqual(['scripting'])
    expect(applied.bands[0].color).toBe('#f0c000')
    // Root maps to itself; subcategory rolls up to the same root id.
    expect(applied.bandForCategory.scripting).toBe('scripting')
    expect(applied.bandForCategory.userScript).toBe('scripting')
    // Categories outside overviewOrder don't get a band mapping.
    expect(applied.bandForCategory.idle).toBeUndefined()
  })

  it('tolerates a parentId cycle by treating the category as a root', () => {
    const cycle: Persona = {
      id: 'cycle',
      name: 'Cycle',
      description: '',
      match: () => 0,
      categories: [
        {id: 'a', label: 'A', color: '#111', parentId: 'b'},
        {id: 'b', label: 'B', color: '#222', parentId: 'a'},
      ],
      colorRules: [],
      trackRules: [],
      // Neither a nor b is a clean root; applyPersona must still
      // terminate without hanging. Whichever id resolves first wins a
      // band slot if listed here; neither listed → bandForCategory stays empty.
      overviewOrder: [],
    }
    const trace = makeTrace([])
    const applied = applyPersona(trace, cycle)
    expect(applied.bands).toEqual([])
    expect(applied.bandForCategory).toEqual({})
  })
})
