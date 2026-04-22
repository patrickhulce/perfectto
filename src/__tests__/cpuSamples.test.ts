import {parseTrace} from '../core/parser'
import type {Measure, TimelineContainer} from '../core'

const SOURCE = {name: 'trace.json', size: 0}

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function findMeasure(
  container: TimelineContainer,
  predicate: (m: Measure) => boolean,
): Measure | null {
  for (const m of container.measures) {
    if (predicate(m)) return m
    const hit = findMeasure(m, predicate)
    if (hit) return hit
  }
  return null
}

function collectMeasures(container: TimelineContainer): Measure[] {
  const out: Measure[] = []
  const walk = (c: TimelineContainer): void => {
    for (const m of c.measures) {
      out.push(m)
      walk(m)
    }
  }
  walk(container)
  return out
}

// CPU profile nodes: (root=1) -> (program=2), (root=1) -> foo=10 -> bar=11
// We only list each node once (the parser accumulates deltas across chunks
// but a single chunk can carry the full set).
const CPU_PROFILE_NODES = [
  {id: 1, callFrame: {functionName: '(root)', scriptId: 0, codeType: 'other'}},
  {
    id: 2,
    parent: 1,
    callFrame: {functionName: '(program)', scriptId: 0, codeType: 'other'},
  },
  {
    id: 10,
    parent: 1,
    callFrame: {functionName: 'foo', scriptId: 42, url: 'app.js', lineNumber: 1, columnNumber: 1},
  },
  {
    id: 11,
    parent: 10,
    callFrame: {functionName: 'bar', scriptId: 42, url: 'app.js', lineNumber: 5, columnNumber: 1},
  },
]

describe('ChromeParser - CPU sample synthesis', () => {
  it('synthesizes JS-frame Measures on the Profile owner thread, not the profiler thread', async () => {
    // Profile opens on tid=100 (main) at ts=0; ProfileChunk arrives on
    // tid=200 (profiler) with samples [foo, foo, bar, bar, program].
    // An EvaluateScript X covers [0, 500] on the main thread so the JS
    // frames should nest under it.
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {
              ph: 'M',
              name: 'thread_name',
              cat: '__metadata',
              pid: 1,
              tid: 100,
              ts: 0,
              args: {name: 'CrRendererMain'},
            },
            {
              ph: 'M',
              name: 'thread_name',
              cat: '__metadata',
              pid: 1,
              tid: 200,
              ts: 0,
              args: {name: 'v8:ProfEvntProc'},
            },
            {
              ph: 'X',
              name: 'EvaluateScript',
              cat: 'devtools.timeline',
              pid: 1,
              tid: 100,
              ts: 0,
              dur: 500,
            },
            {
              ph: 'P',
              name: 'Profile',
              cat: 'disabled-by-default-v8.cpu_profiler',
              pid: 1,
              tid: 100,
              id: '0x1',
              ts: 0,
              args: {data: {source: 'Internal', startTime: 0}},
            },
            {
              ph: 'P',
              name: 'ProfileChunk',
              cat: 'disabled-by-default-v8.cpu_profiler',
              pid: 1,
              tid: 200,
              id: '0x1',
              ts: 0,
              args: {
                data: {
                  cpuProfile: {
                    nodes: CPU_PROFILE_NODES,
                    samples: [10, 10, 11, 11, 2],
                  },
                  timeDeltas: [0, 100, 100, 100, 100],
                },
              },
            },
          ],
        }),
      ),
      SOURCE,
    )

    const renderer = trace.timeline.systems.find(s => s.tracks.some(t => t.name === 'CrRendererMain'))
    expect(renderer).toBeDefined()
    const mainTrack = renderer!.tracks.find(t => t.name === 'CrRendererMain')!
    const profilerTrack = renderer!.tracks.find(t => t.name === 'v8:ProfEvntProc')

    const evalScript = findMeasure(mainTrack, m => m.name === 'EvaluateScript')
    expect(evalScript).not.toBeNull()

    // The synthesized JS frames must live under EvaluateScript, not on the
    // profiler thread (which should be empty — no samples attributed there).
    const fooFrame = findMeasure(evalScript!, m => m.name === 'foo')
    expect(fooFrame).not.toBeNull()
    expect(fooFrame!.category).toBe('jsFrame')

    // timeDeltas sum: sample 0 at 0, 1 at 100, 2 at 200, 3 at 300, 4 at 400.
    // foo runs across samples 0..3 (stack stays [foo, …]); closes at 400.
    // bar runs across samples 2..3 (stack [foo, bar]); closes at 400.
    // Convert from μs to ms: divide by 1000.
    expect(fooFrame!.start).toBeCloseTo(0, 6)
    expect(fooFrame!.end).toBeCloseTo(400 / 1000, 6)

    const barFrame = findMeasure(fooFrame!, m => m.name === 'bar')
    expect(barFrame).not.toBeNull()
    expect(barFrame!.start).toBeCloseTo(200 / 1000, 6)
    expect(barFrame!.end).toBeCloseTo(400 / 1000, 6)

    // No JS-frame measures on the profiler thread: ProfileChunk's own tid
    // must not accrete samples that logically belong to the main thread.
    if (profilerTrack) {
      const jsOnProfiler = collectMeasures(profilerTrack).filter(
        m => m.category === 'jsFrame',
      )
      expect(jsOnProfiler).toHaveLength(0)
    }
  })

  it('drops (root), (program), and (idle) pseudo-frames — no Measure with those names', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {
              ph: 'X',
              name: 'EvaluateScript',
              cat: 'devtools.timeline',
              pid: 1,
              tid: 100,
              ts: 0,
              dur: 500,
            },
            {
              ph: 'P',
              name: 'Profile',
              cat: 'disabled-by-default-v8.cpu_profiler',
              pid: 1,
              tid: 100,
              id: '0x1',
              ts: 0,
              args: {data: {startTime: 0}},
            },
            {
              ph: 'P',
              name: 'ProfileChunk',
              cat: 'disabled-by-default-v8.cpu_profiler',
              pid: 1,
              tid: 200,
              id: '0x1',
              ts: 0,
              args: {
                data: {
                  cpuProfile: {
                    nodes: [
                      ...CPU_PROFILE_NODES,
                      {
                        id: 3,
                        parent: 1,
                        callFrame: {functionName: '(idle)', scriptId: 0, codeType: 'other'},
                      },
                    ],
                    // Two program samples, one foo, then idle.
                    samples: [2, 2, 10, 3],
                  },
                  timeDeltas: [0, 100, 100, 100],
                },
              },
            },
          ],
        }),
      ),
      SOURCE,
    )

    const allMeasures: Measure[] = []
    for (const sys of trace.timeline.systems)
      for (const tr of sys.tracks) allMeasures.push(...collectMeasures(tr))

    // None of the synthesized Measures should carry the pseudo-frame names
    // — DevTools treats them as "no user JS running" gaps.
    const names = new Set(allMeasures.map(m => m.name))
    expect(names.has('(root)')).toBe(false)
    expect(names.has('(program)')).toBe(false)
    expect(names.has('(idle)')).toBe(false)
    // But real user frames survive.
    expect(names.has('foo')).toBe(true)
  })
})

describe('ChromeParser - V8.GC_* collapse', () => {
  const BASE_GC_EVENTS = [
    {ph: 'X', name: 'MinorGC', cat: 'v8', pid: 1, tid: 1, ts: 0, dur: 100},
    {ph: 'X', name: 'V8.GC_SCAVENGER_SCAVENGE', cat: 'v8', pid: 1, tid: 1, ts: 10, dur: 30},
    {ph: 'X', name: 'V8.GC_HEAP_PROLOGUE', cat: 'v8', pid: 1, tid: 1, ts: 20, dur: 5},
    {ph: 'X', name: 'V8.GCScavenger', cat: 'v8', pid: 1, tid: 1, ts: 50, dur: 20},
  ]

  it('default: drops every V8.GC_* leaf so MinorGC renders as a single slice', async () => {
    const trace = await parseTrace(
      streamFromString(JSON.stringify({traceEvents: BASE_GC_EVENTS})),
      SOURCE,
    )
    const track = trace.timeline.systems[0].tracks[0]
    const minor = findMeasure(track, m => m.name === 'MinorGC')
    expect(minor).not.toBeNull()
    // V8.GC_SCAVENGER_SCAVENGE and V8.GC_HEAP_PROLOGUE must not appear
    // anywhere in the tree — they were filtered out on ingest.
    const all = collectMeasures(track)
    expect(all.find(m => m.name === 'V8.GC_SCAVENGER_SCAVENGE')).toBeUndefined()
    expect(all.find(m => m.name === 'V8.GC_HEAP_PROLOGUE')).toBeUndefined()
    // V8.GCScavenger (no underscore) still survives.
    expect(all.find(m => m.name === 'V8.GCScavenger')).toBeDefined()
    // Only V8.GCScavenger nested under MinorGC; the GC_* children are gone.
    expect(minor!.measures.map(m => m.name)).toEqual(['V8.GCScavenger'])
  })

  it('opt-out: collapseGcInternals:false keeps the V8.GC_* subtree intact', async () => {
    const trace = await parseTrace(
      streamFromString(JSON.stringify({traceEvents: BASE_GC_EVENTS})),
      SOURCE,
      {chromeParser: {collapseGcInternals: false}},
    )
    const track = trace.timeline.systems[0].tracks[0]
    const all = collectMeasures(track)
    expect(all.find(m => m.name === 'V8.GC_SCAVENGER_SCAVENGE')).toBeDefined()
    expect(all.find(m => m.name === 'V8.GC_HEAP_PROLOGUE')).toBeDefined()
  })
})
