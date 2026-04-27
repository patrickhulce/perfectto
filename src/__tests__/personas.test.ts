import {
  applyPersona,
  BUILTIN_PERSONAS,
  detectPersona,
  findPersona,
  ML_ENGINEER_PERSONA,
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
  }
}

describe('persona registry', () => {
  it('includes raw, web-dev, and ml-engineer built-ins', () => {
    expect(findPersona('raw')).toBe(RAW_PERSONA)
    expect(findPersona('web-dev')).toBe(WEB_DEV_PERSONA)
    expect(findPersona('ml-engineer')).toBe(ML_ENGINEER_PERSONA)
    expect(findPersona('bogus')).toBeUndefined()
    expect(BUILTIN_PERSONAS).toContain(RAW_PERSONA)
    expect(BUILTIN_PERSONAS).toContain(WEB_DEV_PERSONA)
    expect(BUILTIN_PERSONAS).toContain(ML_ENGINEER_PERSONA)
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

  it('detects ml-engineer persona for Kineto-shaped traces', () => {
    // PyTorch Kineto: every process is named `python` with a labels
    // suffix; GPU streams come through as `stream N` tracks. This
    // should beat both web-dev (no chrome thread names) and raw.
    const cpuThread = makeTrack('cpu-t1', 'thread 490 (python)', [
      m('aten::mm', 0, 10, 'cpu_op'),
    ])
    const gpuStream = makeTrack('gpu-s7', 'stream 7', [
      m('void at::native::elementwise_kernel', 0, 5, 'kernel'),
    ])
    const trace = makeTrace([
      makeSystem('cpu', 'python (CPU)', [cpuThread]),
      makeSystem('gpu0', 'python (GPU 0)', [gpuStream]),
    ])
    expect(detectPersona(trace)).toBe(ML_ENGINEER_PERSONA)
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

describe('applyPersona (ml-engineer)', () => {
  // Helper: pack-and-coerce-to-unsigned for direct comparison against
  // the unsigned values stored in the SliceBuffers `colors` array.
  const packU = (color: string): number => packColor(color, DEFAULT_MEASURE_COLOR) >>> 0

  // Single Kineto-shaped fixture exercising every color rule. One CPU
  // thread carries the python_function frames + cpu_op + cuda_runtime
  // + overhead; one GPU stream carries kernel + memcpy.
  function buildKinetoTrace(): ParsedTrace {
    const cpu = makeTrack('cpu', 'thread 490 (python)', [
      // python_function classification — order in the array drives
      // the assertion indices below.
      m('nn.Module: Gemma3Model_0', 0, 1, 'python_function'), //                0 → userPython
      m('torch/_inductor/foo.py(10): bar', 1, 2, 'python_function'), //         1 → torchPython
      m('transformers/utils/generic.py(1): baz', 2, 3, 'python_function'), //   2 → thirdPartyPython
      m('threading.py(973): _bootstrap', 3, 4, 'python_function'), //           3 → torchPython (stdlib)
      m('myapp/main.py(50): run', 4, 5, 'python_function'), //                  4 → userPython
      // ATen / CUDA API / overhead.
      m('aten::mm', 5, 6, 'cpu_op'), //                                         5 → aten
      m('cudaLaunchKernel', 6, 7, 'cuda_runtime'), //                           6 → system
      m('Buffer Flush', 7, 8, 'overhead'), //                                   7 → system
    ])
    const gpu = makeTrack('gpu', 'stream 7', [
      m('void at::native::elementwise_kernel', 0, 1, 'kernel'), //              0 → gpuKernel
      m('Memcpy DtoH (Device -> Pageable)', 1, 2, 'gpu_memcpy'), //             1 → gpuMemory
    ])
    const compileWorker = makeTrack('cw', 'compile_worker_pool', [
      m('codegen', 0, 1, 'python_function'),
    ])
    return makeTrace([
      makeSystem('cpu', 'python (CPU)', [cpu, compileWorker]),
      makeSystem('gpu0', 'python (GPU 0)', [gpu]),
    ])
  }

  it('routes each Kineto category to the right palette color', () => {
    const trace = buildKinetoTrace()
    applyPersona(trace, ML_ENGINEER_PERSONA)
    const cpu = trace.timeline.systems[0].tracks.find(t => t.id === 'cpu')!
    const gpu = trace.timeline.systems[1].tracks.find(t => t.id === 'gpu')!
    const cb = cpu.buffers!.colors
    const gb = gpu.buffers!.colors

    expect(cb[0]).toBe(packU('#8ed9c1')) // nn.Module → userPython mint
    expect(cb[1]).toBe(packU('#ed8936')) // torch/* → torchPython amber (matches aten)
    expect(cb[2]).toBe(packU('#4398f0')) // transformers/* → thirdPartyPython blue
    expect(cb[3]).toBe(packU('#4398f0')) // threading.py (stdlib) → thirdPartyPython blue
    expect(cb[4]).toBe(packU('#8ed9c1')) // myapp/main.py → userPython mint
    expect(cb[5]).toBe(packU('#ed8936')) // aten::mm (cpu_op) → aten amber
    expect(cb[6]).toBe(packU('#4a5568')) // cudaLaunchKernel → system gray
    expect(cb[7]).toBe(packU('#4a5568')) // Buffer Flush (overhead) → system gray

    expect(gb[0]).toBe(packU('#e8457f')) // kernel → gpuKernel pink
    expect(gb[1]).toBe(packU('#f59ab9')) // gpu_memcpy → gpuMemory pale pink
  })

  it('rolls every Python subcategory and the GPU subcategories into their parent bands', () => {
    const trace = buildKinetoTrace()
    const applied = applyPersona(trace, ML_ENGINEER_PERSONA)
    // All four python subcategories share the same overview band (root
    // `python`); the two GPU subcategories share the `gpu` band.
    expect(applied.bandForCategory.userPython).toBe('python')
    expect(applied.bandForCategory.thirdPartyPython).toBe('python')
    expect(applied.bandForCategory.torchPython).toBe('python')
    expect(applied.bandForCategory.python).toBe('python')
    expect(applied.bandForCategory.gpuKernel).toBe('gpu')
    expect(applied.bandForCategory.gpuMemory).toBe('gpu')
    expect(applied.bandForCategory.aten).toBe('aten')
    expect(applied.bandForCategory.system).toBe('system')
    // Bottom-to-top: system, gpu, aten, python.
    expect(applied.bands.map(b => b.id)).toEqual(['system', 'gpu', 'aten', 'python'])
  })

  it('pins python (CPU) above python (GPU N) and relabels CPU to "Python CPU"', () => {
    const trace = buildKinetoTrace()
    const applied = applyPersona(trace, ML_ENGINEER_PERSONA)
    expect(applied.systems.map(s => s.id)).toEqual(['cpu', 'gpu0'])
    expect(applied.systems[0].name).toBe('Python CPU')
    // GPU process keeps its disambiguating label so multi-GPU traces
    // stay readable.
    expect(applied.systems[1].name).toBe('python (GPU 0)')
    expect(applied.defaultSystemExpanded.cpu).toBe(true)
    expect(applied.defaultSystemExpanded.gpu0).toBe(true)
  })

  it('expands the dominant python thread and kernel stream, hides compile-worker pools', () => {
    const trace = buildKinetoTrace()
    const applied = applyPersona(trace, ML_ENGINEER_PERSONA)
    expect(applied.defaultTrackExpanded.cpu).toBe(true)
    expect(applied.defaultTrackExpanded.gpu).toBe(true)
    // Compile workers live in hiddenTracksBySystem under their parent.
    const visibleCpu = applied.systems[0].tracks.map(t => t.id)
    expect(visibleCpu).not.toContain('cw')
    expect(applied.hiddenTracksBySystem.cpu?.map(t => t.id)).toContain('cw')
  })

  it('features only the busiest python thread when multiple candidates exist', () => {
    // Real Kineto traces have one dominant `thread <pid> (python)`
    // and a long tail of short-lived workers. Static rules can't pick
    // the dominant one — featureTracks does, by event count.
    const main = makeTrack(
      'cpu-main',
      'thread 490 (python)',
      Array.from({length: 50}, (_, i) => m(`f${i}`, i, i + 1, 'python_function')),
    )
    const idle = makeTrack('cpu-idle', 'thread 491 (python)', [
      m('idle', 0, 1, 'python_function'),
    ])
    const gpuKernels = makeTrack('gpu-busy', 'stream 7', [
      m('kernel a', 0, 1, 'kernel'),
      m('kernel b', 1, 2, 'kernel'),
      m('memcpy', 2, 3, 'gpu_memcpy'),
    ])
    const gpuMemcpyOnly = makeTrack('gpu-mem', 'stream 8', [
      m('memcpy a', 0, 1, 'gpu_memcpy'),
      m('memcpy b', 1, 2, 'gpu_memcpy'),
    ])
    const trace = makeTrace([
      makeSystem('cpu', 'python (CPU)', [idle, main]),
      makeSystem('gpu0', 'python (GPU 0)', [gpuMemcpyOnly, gpuKernels]),
    ])
    const applied = applyPersona(trace, ML_ENGINEER_PERSONA)

    // Dominant python thread wins; the idle worker stays collapsed.
    expect(applied.defaultTrackExpanded['cpu-main']).toBe(true)
    expect(applied.defaultTrackExpanded['cpu-idle']).toBe(false)
    // Stream with kernels wins; the memcpy-only stream stays
    // collapsed even though the persona-baseline would otherwise
    // collapse both.
    expect(applied.defaultTrackExpanded['gpu-busy']).toBe(true)
    expect(applied.defaultTrackExpanded['gpu-mem']).toBe(false)
  })

  it("tolerates Kineto's trailing-space track names ('stream 7 ', 'thread 490 (python) ')", () => {
    // Real PyTorch Kineto traces emit `thread_name` metadata with a
    // trailing space for GPU streams (literal `"stream 7 "`). A regex
    // anchored at the digit (`\d+$`) silently misses every real
    // trace, so the persona ends up with no featured tracks and the
    // overview falls back to "everything visible," which on an ML
    // workload reads as a mostly-idle CPU thread with sparse gray
    // cuda_runtime peaks. Hardcoded the literal name here so we can't
    // accidentally re-introduce that drop.
    const cpuThread = makeTrack('cpu', 'thread 490 (python) ', [
      m('aten::mm', 0, 5, 'cpu_op'),
    ])
    const gpuStream = makeTrack('gpu', 'stream 7 ', [
      m('elementwise_kernel', 0, 1, 'kernel'),
      m('elementwise_kernel', 1, 2, 'kernel'),
    ])
    const trace = makeTrace([
      makeSystem('cpu', 'python (CPU)', [cpuThread]),
      makeSystem('gpu0', 'python (GPU 0)', [gpuStream]),
    ])
    const applied = applyPersona(trace, ML_ENGINEER_PERSONA)
    expect(applied.defaultTrackExpanded.cpu).toBe(true)
    expect(applied.defaultTrackExpanded.gpu).toBe(true)
    expect(applied.defaultSystemExpanded.gpu0).toBe(true)
    // And the GPU stream actually makes it into the overview-scoped
    // systems — without that, the overview chart goes dark on real
    // Kineto traces.
    const overviewIds = applied.overviewSystems.flatMap(s => s.tracks.map(t => t.id))
    expect(overviewIds).toContain('gpu')
  })

  it('paints cudaGraphLaunch with the pale-pink GPU-memory color, not system gray', () => {
    // `cudaGraphLaunch` is a CPU-side API call but represents a whole
    // pre-recorded GPU graph being kicked off in one shot — call it
    // out distinctly from per-kernel launches (which stay in the
    // system bucket). Specific rule must beat the generic
    // `cuda_runtime → system` catch-all.
    const cpu = makeTrack('cpu', 'thread 490 (python)', [
      m('cudaGraphLaunch', 0, 1, 'cuda_runtime'),
      m('cudaLaunchKernel', 1, 2, 'cuda_runtime'),
    ])
    const trace = makeTrace([makeSystem('cpu', 'python (CPU)', [cpu])])
    applyPersona(trace, ML_ENGINEER_PERSONA)
    const cb = trace.timeline.systems[0].tracks[0].buffers!.colors
    expect(cb[0]).toBe(packU('#f59ab9')) // cudaGraphLaunch → gpuMemory pale pink
    expect(cb[1]).toBe(packU('#4a5568')) // cudaLaunchKernel → system gray
  })

  it('leaves an idle GPU system collapsed when none of its streams have kernels', () => {
    // Multi-GPU traces ship with one busy GPU and a stack of idle
    // siblings (just memcpy / annotation events, no compute). The
    // idle systems should stay collapsed so the user isn't paging
    // through empty timelines on first open.
    const cpuThread = makeTrack('cpu', 'thread 490 (python)', [
      m('aten::mm', 0, 1, 'cpu_op'),
    ])
    const busyStream = makeTrack('gpu0-s7', 'stream 7', [
      m('kernel', 0, 1, 'kernel'),
    ])
    const idleStream = makeTrack('gpu1-s7', 'stream 7', [
      m('memcpy', 0, 1, 'gpu_memcpy'),
    ])
    const trace = makeTrace([
      makeSystem('cpu', 'python (CPU)', [cpuThread]),
      makeSystem('gpu0', 'python (GPU 0)', [busyStream]),
      makeSystem('gpu1', 'python (GPU 1)', [idleStream]),
    ])
    const applied = applyPersona(trace, ML_ENGINEER_PERSONA)

    // Busy GPU's system is forced open by featureTracks; idle GPU
    // falls through to the persona-wide `defaultSystemsExpanded:
    // false` baseline.
    expect(applied.defaultSystemExpanded.gpu0).toBe(true)
    expect(applied.defaultSystemExpanded.gpu1).toBe(false)
    // And that idle stream itself stays collapsed.
    expect(applied.defaultTrackExpanded['gpu1-s7']).toBe(false)
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
