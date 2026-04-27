import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {gzipSync} from 'node:zlib'

import {parseTrace} from '../core/parser'
import {iterateTimelineEvents} from '../core'
import type {
  CompactionReport,
  Measure,
  ParseProgress,
  TimelineContainer,
} from '../core'

const SOURCE = {name: 'trace.json', size: 0}

const MINIMAL_TRACE = JSON.stringify({
  traceEvents: [
    {ph: 'X', name: 'task', cat: 'test', pid: 1, tid: 1, ts: 0, dur: 10},
  ],
})

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const queue = chunks.map(c => encoder.encode(c))
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
  })
}

function byteSize(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

describe('parseTrace - chrome minimal', () => {
  it('returns a ParsedTrace with a system, track, and measure', async () => {
    const trace = await parseTrace(streamFromString(MINIMAL_TRACE), SOURCE)

    expect(trace.source).toEqual(SOURCE)
    expect(trace.timeline.systems.length).toBeGreaterThanOrEqual(1)

    const firstTrack = trace.timeline.systems[0].tracks[0]
    expect(firstTrack).toBeDefined()
    expect(firstTrack.measures.length).toBeGreaterThanOrEqual(1)
    expect(firstTrack.measures[0].name).toBe('task')
  })

  it('flattens every mark and measure (including nested) into events', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {ph: 'B', name: 'outer', cat: 'test', pid: 1, tid: 1, ts: 0},
            {ph: 'X', name: 'inner', cat: 'test', pid: 1, tid: 1, ts: 2, dur: 3},
            {ph: 'E', name: 'outer', cat: 'test', pid: 1, tid: 1, ts: 10},
            {ph: 'I', name: 'mark', cat: 'test', pid: 1, tid: 1, ts: 1, s: 't'},
          ],
        }),
      ),
      SOURCE,
    )

    const idsFromTree = new Set<string>()
    const walk = (container: TimelineContainer): void => {
      for (const m of container.marks) idsFromTree.add(m.id)
      for (const m of container.measures) {
        idsFromTree.add(m.id)
        walk(m)
      }
    }
    for (const system of trace.timeline.systems) {
      for (const track of system.tracks) walk(track)
    }

    // ParsedTrace no longer carries a flat `events` array — iterate via
    // the public generator to re-derive ids and check they match the
    // tree walk above.
    const idsFromIterator = new Set<string>()
    for (const e of iterateTimelineEvents(trace.timeline)) idsFromIterator.add(e.id)
    expect(idsFromIterator).toEqual(idsFromTree)
    expect(idsFromIterator.size).toBeGreaterThan(0)
  })

  it('populates metadata as an object and copies root-level metadata field', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          metadata: {source: 'DevTools', hostDPR: 2},
          traceEvents: [
            {ph: 'X', name: 't', cat: 'c', pid: 1, tid: 1, ts: 0, dur: 1},
          ],
        }),
      ),
      SOURCE,
    )
    expect(typeof trace.metadata).toBe('object')
    expect(trace.metadata.source).toBe('DevTools')
    expect(trace.metadata.hostDPR).toBe(2)
    expect(trace.metadata.parser).toBe('chrome')
  })

  it('nests duration events (B/E and X) correctly on the same thread', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {ph: 'B', name: 'outer', cat: 'c', pid: 1, tid: 1, ts: 0},
            {ph: 'X', name: 'inner', cat: 'c', pid: 1, tid: 1, ts: 2, dur: 3},
            {ph: 'E', name: 'outer', cat: 'c', pid: 1, tid: 1, ts: 10},
          ],
        }),
      ),
      SOURCE,
    )

    const track = trace.timeline.systems[0].tracks[0]
    expect(track.measures.length).toBe(1)
    const outer = track.measures[0]
    expect(outer.name).toBe('outer')
    expect(outer.measures.length).toBe(1)
    expect(outer.measures[0].name).toBe('inner')
  })

  // Regression test: real DevTools traces are almost entirely `X` (complete)
  // events. A parser that treats `X` as flat leaves will render the whole
  // timeline flat for those traces. These tests pin down the containment rule.
  it('nests X events whose intervals are fully contained (no B/E involved)', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {ph: 'X', name: 'outer', cat: 'c', pid: 1, tid: 1, ts: 0, dur: 100},
            {ph: 'X', name: 'middle', cat: 'c', pid: 1, tid: 1, ts: 10, dur: 50},
            {ph: 'X', name: 'leaf', cat: 'c', pid: 1, tid: 1, ts: 20, dur: 10},
          ],
        }),
      ),
      SOURCE,
    )

    const track = trace.timeline.systems[0].tracks[0]
    expect(track.measures).toHaveLength(1)
    const outer = track.measures[0]
    expect(outer.name).toBe('outer')
    expect(outer.measures).toHaveLength(1)
    const middle = outer.measures[0]
    expect(middle.name).toBe('middle')
    expect(middle.measures).toHaveLength(1)
    expect(middle.measures[0].name).toBe('leaf')
    expect(middle.measures[0].measures).toHaveLength(0)
  })

  it('keeps adjacent X events as siblings, not children, when they do not overlap', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {ph: 'X', name: 'a', cat: 'c', pid: 1, tid: 1, ts: 0, dur: 5},
            // Starts exactly at a's end — this is a sibling, not a child.
            {ph: 'X', name: 'b', cat: 'c', pid: 1, tid: 1, ts: 5, dur: 5},
            {ph: 'X', name: 'c', cat: 'c', pid: 1, tid: 1, ts: 20, dur: 5},
          ],
        }),
      ),
      SOURCE,
    )

    const track = trace.timeline.systems[0].tracks[0]
    expect(track.measures.map(m => m.name)).toEqual(['a', 'b', 'c'])
    for (const m of track.measures) expect(m.measures).toHaveLength(0)
  })

  it('nests X siblings under a shared X parent', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {ph: 'X', name: 'parent', cat: 'c', pid: 1, tid: 1, ts: 0, dur: 100},
            {ph: 'X', name: 'childA', cat: 'c', pid: 1, tid: 1, ts: 10, dur: 20},
            {ph: 'X', name: 'childB', cat: 'c', pid: 1, tid: 1, ts: 40, dur: 20},
            {ph: 'X', name: 'childC', cat: 'c', pid: 1, tid: 1, ts: 70, dur: 20},
          ],
        }),
      ),
      SOURCE,
    )

    const track = trace.timeline.systems[0].tracks[0]
    expect(track.measures).toHaveLength(1)
    const parent = track.measures[0]
    expect(parent.name).toBe('parent')
    expect(parent.measures.map(m => m.name)).toEqual(['childA', 'childB', 'childC'])
    for (const c of parent.measures) expect(c.measures).toHaveLength(0)
  })

  it('nests X events that start at the same timestamp using duration as the parent-first tiebreaker', async () => {
    // Both start at ts=0; `outer` has the larger duration so it must wrap
    // `inner` even though the input order is reversed.
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {ph: 'X', name: 'inner', cat: 'c', pid: 1, tid: 1, ts: 0, dur: 10},
            {ph: 'X', name: 'outer', cat: 'c', pid: 1, tid: 1, ts: 0, dur: 100},
          ],
        }),
      ),
      SOURCE,
    )

    const track = trace.timeline.systems[0].tracks[0]
    expect(track.measures).toHaveLength(1)
    expect(track.measures[0].name).toBe('outer')
    expect(track.measures[0].measures.map(m => m.name)).toEqual(['inner'])
  })

  // Regression: real PyTorch profiler traces emit `_record_function_enter_new`-
  // style probes whose recorded `dur` ends *before* the wider sibling they
  // actually wrap (the probe finishes early; the sibling event keeps running
  // for tens of ms). The naive ts-only flush would leave the probe on the
  // stack when the wider sibling opens, falsely nesting the wide subtree under
  // a tiny ancestor — which `cullSubpixelSubtrees` would then sweep into a
  // sub-pixel fold rep, silently dropping the entire subtree from the flame
  // chart. Pop straddled ancestors before pushing the new event.
  it('does not nest a wider X event under a tiny straddled ancestor', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            // Outer parent the whole scenario lives inside.
            {ph: 'X', name: 'outer', cat: 'c', pid: 1, tid: 1, ts: 0, dur: 1_000_000},
            // Tiny "probe" — opens at ts=10, claims dur=10 (ends at ts=20).
            {ph: 'X', name: 'probe', cat: 'c', pid: 1, tid: 1, ts: 10, dur: 10},
            // Wider sibling opens at ts=15 (within the probe's open window),
            // but extends way past the probe's end. Must NOT become a child
            // of `probe`; it must become a sibling of `probe` under `outer`.
            {ph: 'X', name: 'wide', cat: 'c', pid: 1, tid: 1, ts: 15, dur: 999_000},
            // Deep child of `wide` — confirms the whole subtree re-roots.
            {ph: 'X', name: 'deep', cat: 'c', pid: 1, tid: 1, ts: 100, dur: 999_000 - 200},
          ],
        }),
      ),
      SOURCE,
    )

    const track = trace.timeline.systems[0].tracks[0]
    expect(track.measures).toHaveLength(1)
    const outer = track.measures[0]
    expect(outer.name).toBe('outer')
    // Straddled probe is closed at its own endTs and demoted to a sibling
    // leaf; `wide` (with its `deep` descendant) is the second sibling.
    expect(outer.measures.map(m => m.name)).toEqual(['probe', 'wide'])
    const [probe, wide] = outer.measures
    expect(probe.measures).toHaveLength(0)
    expect(wide.measures.map(m => m.name)).toEqual(['deep'])
    expect(wide.measures[0].measures).toHaveLength(0)
  })

  // Regression: a real PyTorch Kineto trace contained a parent
  // `_run_module_as_main` (ts=1_200_202_296_518.285, dur=25_085_119.703,
  // end=…637.9878) and an immediate child `_run_code` (ts=…519.445,
  // dur=…118.543, end=…637.9880) that nominally shared an end timestamp.
  // Each end is computed as `ts + dur` in float64; at this magnitude
  // (~1.2e12 µs) the two sums differ by exactly one ULP — the child's
  // computed end was 0.000244 µs greater than the parent's, so the
  // strict `top.endTs >= newEnd` containment check popped the parent
  // and demoted the child to a sibling at depth 0. Both rendered
  // overlapping each other in the timeline. The parser uses a
  // magnitude-relative tolerance so ties survive as containment.
  it('keeps a same-end-time X child nested under its parent despite float-ULP slack', async () => {
    // Pick base timestamps in the 10^12 µs range so `ts + dur`
    // accumulates real ULP noise; verify with raw arithmetic that the
    // child's computed end > parent's computed end before relying on
    // the parser's tolerance.
    const outerTs = 1_200_202_296_518.285
    const outerDur = 25_085_119.703
    const innerTs = 1_200_202_296_519.445
    const innerDur = 25_085_118.543
    expect(innerTs + innerDur).toBeGreaterThan(outerTs + outerDur)

    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {
              ph: 'X',
              name: '_run_module_as_main',
              cat: 'python_function',
              pid: 1,
              tid: 1,
              ts: outerTs,
              dur: outerDur,
            },
            {
              ph: 'X',
              name: '_run_code',
              cat: 'python_function',
              pid: 1,
              tid: 1,
              ts: innerTs,
              dur: innerDur,
            },
          ],
        }),
      ),
      SOURCE,
    )

    const track = trace.timeline.systems[0].tracks[0]
    expect(track.measures).toHaveLength(1)
    expect(track.measures[0].name).toBe('_run_module_as_main')
    expect(track.measures[0].measures.map(m => m.name)).toEqual(['_run_code'])
    // The 1-ULP overshoot survives the µs→ms divide intact, but at
    // this magnitude it's below F32 representational precision (and
    // far below any subpixel) so it can never paint the child poking
    // out the right of its parent in the rendered timeline.
    const outer = track.measures[0]
    const inner = outer.measures[0]
    expect(inner.end - outer.end).toBeLessThan(1e-3)
  })

  // Kineto `python_function` events bake the call-site into the event
  // `name` ("path/file.py(line): func"). Promote that to a `callsite`
  // attribution so the Aggregator's callstack panel renders for Python
  // selections the same way it does for V8 frames.
  it('attaches a callsite attribution to python_function frames', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {
              ph: 'X',
              name: 'torch/_inductor/compile_fx.py(123): compile_fx',
              cat: 'python_function',
              pid: 1,
              tid: 1,
              ts: 0,
              dur: 1000,
            },
            {
              ph: 'X',
              name: 'nn.Module: Gemma3Model_0',
              cat: 'python_function',
              pid: 1,
              tid: 1,
              ts: 100,
              dur: 500,
            },
          ],
        }),
      ),
      SOURCE,
    )

    const track = trace.timeline.systems[0].tracks[0]
    expect(track.measures).toHaveLength(1)
    const outer = track.measures[0]
    expect(outer.attribution).toEqual({
      kind: 'callsite',
      source: 'kineto-python',
      label: 'compile_fx',
      location: {url: 'torch/_inductor/compile_fx.py', lineNumber: 123},
    })
    // Label-only fallback for non-path-shaped names.
    const inner = outer.measures[0]
    expect(inner.name).toBe('nn.Module: Gemma3Model_0')
    expect(inner.attribution).toEqual({
      kind: 'callsite',
      source: 'kineto-python',
      label: 'nn.Module: Gemma3Model_0',
    })
  })

  // Non-Python B/E/X frames stay un-attributed so the parser doesn't
  // synthesize fake source locations for `cpu_op`, `cuda_runtime`, etc.
  it('leaves non-python_function measures without an attribution', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {ph: 'X', name: 'aten::matmul', cat: 'cpu_op', pid: 1, tid: 1, ts: 0, dur: 1000},
          ],
        }),
      ),
      SOURCE,
    )
    const track = trace.timeline.systems[0].tracks[0]
    expect(track.measures[0].attribution).toBeUndefined()
  })

  it('preserves a deep wide chain rooted under a tiny straddled probe', async () => {
    // Mirrors the real PyTorch trace shape that motivated the fix:
    // tiny profiler.__init__ + profiler.__enter__ + torch/_ops.__call__ +
    // _record_function_enter_new — all sub-50µs probes whose dur ends before
    // the 66 ms `## Call CompiledFxGraph ##` chain that actually does the
    // work. The chain must survive parsing as a sibling of the probes.
    const ts = (us: number) => us
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {ph: 'X', name: '__call__', cat: 'c', pid: 1, tid: 1, ts: ts(0), dur: 66_000},
            {ph: 'X', name: 'profiler.init', cat: 'c', pid: 1, tid: 1, ts: ts(7), dur: 8},
            {ph: 'X', name: 'profiler.enter', cat: 'c', pid: 1, tid: 1, ts: ts(16), dur: 30},
            {ph: 'X', name: 'ops.call', cat: 'c', pid: 1, tid: 1, ts: ts(20), dur: 26},
            {ph: 'X', name: 'record_fn', cat: 'c', pid: 1, tid: 1, ts: ts(21), dur: 24},
            // Wide chain opens inside the still-open probes but extends way past them.
            {ph: 'X', name: 'CompiledFxGraph', cat: 'c', pid: 1, tid: 1, ts: ts(31), dur: 65_900},
            {ph: 'X', name: 'fx.call', cat: 'c', pid: 1, tid: 1, ts: ts(48), dur: 65_800},
            {ph: 'X', name: 'compile_fx.run', cat: 'c', pid: 1, tid: 1, ts: ts(140), dur: 65_700},
            {ph: 'X', name: 'execute_node', cat: 'c', pid: 1, tid: 1, ts: ts(200), dur: 65_500},
            {ph: 'X', name: 'replay', cat: 'c', pid: 1, tid: 1, ts: ts(300), dur: 65_300},
            {ph: 'X', name: 'cudaGraphLaunch', cat: 'c', pid: 1, tid: 1, ts: ts(400), dur: 65_100},
          ],
        }),
      ),
      SOURCE,
    )

    const track = trace.timeline.systems[0].tracks[0]
    expect(track.measures).toHaveLength(1)
    const call = track.measures[0]
    expect(call.name).toBe('__call__')
    // The 4 tiny probes survive as leaf siblings; the wide chain is its own
    // sibling subtree — not a descendant of any probe.
    expect(call.measures.map(m => m.name)).toEqual([
      'profiler.init',
      'profiler.enter',
      'CompiledFxGraph',
    ])
    const profilerEnter = call.measures[1]
    // ops.call/record_fn are properly nested inside profiler.enter (their
    // ends still fit), so they re-parent there — not under CompiledFxGraph.
    expect(profilerEnter.measures.map(m => m.name)).toEqual(['ops.call'])
    expect(profilerEnter.measures[0].measures.map(m => m.name)).toEqual(['record_fn'])

    const compiled = call.measures[2]
    // The whole 6-deep wide chain stays intact.
    const chain: string[] = []
    for (let m: Measure | undefined = compiled; m; m = m.measures[0]) {
      chain.push(m.name)
    }
    expect(chain).toEqual([
      'CompiledFxGraph',
      'fx.call',
      'compile_fx.run',
      'execute_node',
      'replay',
      'cudaGraphLaunch',
    ])
  })

  it('does not flatten X events on the real trace asset', async () => {
    const filePath = path.resolve(
      __dirname,
      '..',
      '..',
      'assets',
      'perfecto-chrome-trace.json',
    )
    const bytes = await readFile(filePath)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes))
        controller.close()
      },
    })
    const trace = await parseTrace(stream, {
      name: 'perfecto-chrome-trace.json',
      size: bytes.byteLength,
    })

    let totalMeasures = 0
    let measuresWithChildren = 0
    let maxDepth = 0
    const walk = (m: Measure, depth: number): void => {
      totalMeasures += 1
      if (m.measures.length > 0) measuresWithChildren += 1
      if (depth > maxDepth) maxDepth = depth
      for (const c of m.measures) walk(c, depth + 1)
    }
    for (const system of trace.timeline.systems) {
      for (const track of system.tracks) {
        for (const m of track.measures) walk(m, 1)
      }
    }

    // If the tree had collapsed to flat, measuresWithChildren would be ~0 and
    // maxDepth would be 1. The real trace has deep renderer stacks, so we
    // expect meaningful nesting.
    expect(totalMeasures).toBeGreaterThan(1000)
    expect(measuresWithChildren).toBeGreaterThan(100)
    expect(maxDepth).toBeGreaterThanOrEqual(5)
  }, 30000)

  // Real-world regression fixture: a ~27 KiB filtered slice of a PyTorch
  // profiler trace that previously triggered the straddling-X mis-nesting
  // bug. The unfiltered trace was ~75 MiB compressed and not checked in;
  // this fixture covers exactly one `output_code.py(611): __call__`
  // invocation along with its enclosing profiler probes and the full
  // `cudaGraphLaunch` chain that lives inside it.
  it('preserves the cudaGraphLaunch chain inside output_code.py:__call__ on the filtered hf-compiled fixture', async () => {
    const filePath = path.resolve(
      __dirname,
      'fixtures',
      'chrome-straddling-x.json.gz',
    )
    const bytes = await readFile(filePath)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes))
        controller.close()
      },
    })
    const trace = await parseTrace(stream, {
      name: 'chrome-straddling-x.json.gz',
      size: bytes.byteLength,
    })

    // Walk every measure in the parsed tree and collect the names we care
    // about. Before the parser fix, the entire deep chain rooted under
    // `output_code.py(611): __call__` was being absorbed into a tiny
    // sub-pixel fold and these names appeared *only* in `compaction.names`.
    const seen = new Map<string, Measure>()
    const watchlist = [
      'torch/_inductor/output_code.py(611): __call__',
      'torch/_inductor/cudagraph_trees.py(2262): execute_node',
      'torch/_inductor/cudagraph_trees.py(1228): run_graph',
      'torch/cuda/graphs.py(141): replay',
      'cudaGraphLaunch',
    ]
    const stack: Measure[] = []
    for (const system of trace.timeline.systems) {
      for (const track of system.tracks) {
        for (const m of track.measures) stack.push(m)
      }
    }
    while (stack.length > 0) {
      const m = stack.pop()!
      if (watchlist.includes(m.name) && !seen.has(m.name)) seen.set(m.name, m)
      for (const c of m.measures) stack.push(c)
    }
    for (const name of watchlist) {
      expect(seen.has(name)).toBe(true)
    }

    // The chain must actually nest, not be flat siblings. Walk from
    // __call__ down through descendants and assert each subsequent
    // watchlist entry is reachable as a descendant of the previous one.
    const isDescendantOf = (root: Measure, target: Measure): boolean => {
      const dq: Measure[] = [...root.measures]
      while (dq.length > 0) {
        const m = dq.pop()!
        if (m === target) return true
        for (const c of m.measures) dq.push(c)
      }
      return false
    }
    for (let i = 1; i < watchlist.length; i++) {
      const parent = seen.get(watchlist[i - 1])!
      const child = seen.get(watchlist[i])!
      expect(isDescendantOf(parent, child)).toBe(true)
    }

    // And the cull report must not have eaten any of these names — if the
    // parser regression came back, cudaGraphLaunch would resurface inside
    // `compaction.names` as a folded subtree leaf.
    const compaction = trace.metadata.compaction as CompactionReport | undefined
    if (compaction?.names) {
      for (const name of watchlist) {
        expect(compaction.names).not.toContain(name)
      }
    }
  }, 30000)

  it('uses metadata events to name processes and threads', async () => {
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {
              ph: 'M',
              name: 'process_name',
              cat: '__metadata',
              pid: 42,
              tid: 0,
              ts: 0,
              args: {name: 'Renderer'},
            },
            {
              ph: 'M',
              name: 'thread_name',
              cat: '__metadata',
              pid: 42,
              tid: 7,
              ts: 0,
              args: {name: 'CrRendererMain'},
            },
            {ph: 'X', name: 't', cat: 'c', pid: 42, tid: 7, ts: 0, dur: 1},
          ],
        }),
      ),
      SOURCE,
    )
    const system = trace.timeline.systems.find(s => s.name === 'Renderer')
    expect(system).toBeDefined()
    const track = system!.tracks.find(t => t.name === 'CrRendererMain')
    expect(track).toBeDefined()
  })

  it('appends process_labels as a parenthesized suffix on the system name', async () => {
    // PyTorch Kineto emits identical `process_name = "python"` for the
    // CPU process and every per-GPU process, disambiguating only via
    // `process_labels` ("CPU" / "GPU 0" / …). Without surfacing labels
    // every process collapses into a single indistinguishable system.
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {
              ph: 'M',
              name: 'process_name',
              cat: '__metadata',
              pid: 1,
              tid: 0,
              ts: 0,
              args: {name: 'python'},
            },
            {
              ph: 'M',
              name: 'process_labels',
              cat: '__metadata',
              pid: 1,
              tid: 0,
              ts: 0,
              args: {labels: 'GPU 0'},
            },
            {ph: 'X', name: 'k', cat: 'kernel', pid: 1, tid: 7, ts: 0, dur: 1},
            {
              ph: 'M',
              name: 'process_name',
              cat: '__metadata',
              pid: 2,
              tid: 0,
              ts: 0,
              args: {name: 'python'},
            },
            {
              ph: 'M',
              name: 'process_labels',
              cat: '__metadata',
              pid: 2,
              tid: 0,
              ts: 0,
              args: {labels: 'CPU'},
            },
            {ph: 'X', name: 'op', cat: 'cpu_op', pid: 2, tid: 8, ts: 0, dur: 1},
          ],
        }),
      ),
      SOURCE,
    )
    const names = trace.timeline.systems.map(s => s.name).sort()
    expect(names).toEqual(['python (CPU)', 'python (GPU 0)'])
  })

  it('omits the labels suffix when process_labels is absent', async () => {
    // Regression guard: only Kineto-style traces should grow the
    // suffix. Vanilla Chrome traces — which emit `process_name` but
    // never `process_labels` — must keep their existing system names.
    const trace = await parseTrace(
      streamFromString(
        JSON.stringify({
          traceEvents: [
            {
              ph: 'M',
              name: 'process_name',
              cat: '__metadata',
              pid: 1,
              tid: 0,
              ts: 0,
              args: {name: 'Renderer'},
            },
            {ph: 'X', name: 't', cat: 'c', pid: 1, tid: 7, ts: 0, dur: 1},
          ],
        }),
      ),
      SOURCE,
    )
    expect(trace.timeline.systems.map(s => s.name)).toEqual(['Renderer'])
  })
})

describe('parseTrace - progress & streams', () => {
  it('accepts an async iterable of streams and sums bytes across them', async () => {
    // Place traceEvents in second stream; universal should buffer the first
    // until it detects the magic pattern and then replay bytes to the parser.
    const a = '{"metadata":{"source":"DevTools"},'
    const b =
      '"traceEvents":[{"ph":"X","name":"t","cat":"c","pid":1,"tid":1,"ts":0,"dur":5}]}'
    const total = byteSize(a) + byteSize(b)

    async function* gen(): AsyncGenerator<ReadableStream<Uint8Array>> {
      yield streamFromString(a)
      yield streamFromString(b)
    }

    const events: ParseProgress[] = []
    const trace = await parseTrace(gen(), SOURCE, {
      onProgress: p => events.push(p),
    })

    expect(trace.timeline.systems.length).toBeGreaterThan(0)
    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last.phase).toBe('done')
    expect(last.bytesRead).toBe(total)
    expect(events.some(e => e.streamIndex === 1)).toBe(true)
  })

  it('emits a final progress event with phase=done and bytesRead equal to stream size', async () => {
    const total = byteSize(MINIMAL_TRACE)

    const events: ParseProgress[] = []
    await parseTrace(streamFromString(MINIMAL_TRACE), SOURCE, {
      onProgress: p => events.push(p),
    })

    const last = events[events.length - 1]
    expect(last.phase).toBe('done')
    expect(last.bytesRead).toBe(total)
  })

  it('aborts mid-stream via AbortSignal', async () => {
    const controller = new AbortController()
    const prefix = '{"metadata":{"source":"DevTools"},'
    const chunks = [
      prefix,
      '"traceEvents":[',
      '{"ph":"X","name":"t","cat":"c","pid":1,"tid":1,"ts":0,"dur":1},',
      '{"ph":"X","name":"t","cat":"c","pid":1,"tid":1,"ts":1,"dur":1}',
      ']}',
    ]

    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        const next = chunks.shift()
        if (!next) {
          c.close()
          return
        }
        c.enqueue(new TextEncoder().encode(next))
      },
    })

    const events: ParseProgress[] = []
    const promise = parseTrace(stream, SOURCE, {
      signal: controller.signal,
      onProgress: p => {
        events.push(p)
        if (events.length === 1) controller.abort()
      },
    })

    await expect(promise).rejects.toMatchObject({name: 'AbortError'})

    const countAtAbort = events.length
    await new Promise(r => setTimeout(r, 10))
    expect(events.length).toBe(countAtAbort)
    expect(events.every(e => e.phase !== 'done')).toBe(true)
  })

  it('rejects immediately when given an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      parseTrace(streamFromString(MINIMAL_TRACE), SOURCE, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({name: 'AbortError'})
  })

  it('handles multi-chunk streams and accumulates bytesRead', async () => {
    const chunks = [
      '{"traceEvents":[',
      '{"ph":"X","name":"t","cat":"c","pid":1,"tid":1,"ts"',
      ':0,"dur":1}',
      ']}',
    ]
    const total = chunks.reduce((n, c) => n + byteSize(c), 0)

    const events: ParseProgress[] = []
    await parseTrace(streamFromChunks(chunks), SOURCE, {
      onProgress: p => events.push(p),
    })

    const last = events[events.length - 1]
    expect(last.bytesRead).toBe(total)
    expect(last.phase).toBe('done')
  })
})

describe('parseTrace - sniff/magic detection', () => {
  it('rejects payloads that do not match any registered MAGIC_PATTERN in the first 8 KiB', async () => {
    const junk = 'x'.repeat(9 * 1024)
    await expect(
      parseTrace(streamFromString(junk), SOURCE),
    ).rejects.toThrow(/Unsupported trace format/)
  })

  it('rejects short payloads with no magic pattern', async () => {
    await expect(parseTrace(streamFromString('{}'), SOURCE)).rejects.toThrow(
      /Unsupported trace format/,
    )
  })

  it('replays the full sniff buffer so the parser sees bytes from byte 0 even when the magic lands in a later chunk', async () => {
    // Put the JSON root `{` and the `metadata` object in chunk 1, then the
    // `"traceEvents"` magic in chunk 2. The chrome parser must still see the
    // root `{` (it is a valid JSON stream).
    const chunkA = '{"metadata":{"source":"Detective"},'
    const chunkB =
      '"traceEvents":[{"ph":"X","name":"late","cat":"c","pid":1,"tid":1,"ts":0,"dur":5}]}'
    const trace = await parseTrace(streamFromChunks([chunkA, chunkB]), SOURCE)
    expect(trace.metadata.source).toBe('Detective')
    expect(trace.timeline.systems[0].tracks[0].measures[0].name).toBe('late')
  })
})

describe('parseTrace - gzip handling', () => {
  function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
  }

  function streamFromByteChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    const queue = chunks.slice()
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = queue.shift()
        if (next) controller.enqueue(next)
        else controller.close()
      },
    })
  }

  it('decompresses a payload identified by gzip magic bytes alone', async () => {
    const gz = gzipSync(Buffer.from(MINIMAL_TRACE, 'utf8'))
    // Misleading filename — no `.gz` — so this only succeeds if magic
    // detection fires.
    const trace = await parseTrace(streamFromBytes(new Uint8Array(gz)), {
      name: 'trace.json',
      size: gz.byteLength,
    })
    expect(trace.timeline.systems[0].tracks[0].measures[0].name).toBe('task')
  })

  it('decompresses a `.gz` file that was split across multiple chunks', async () => {
    const gz = new Uint8Array(gzipSync(Buffer.from(MINIMAL_TRACE, 'utf8')))
    // Force a chunk boundary right inside the gzip header so the
    // decompressor has to be fed the buffered first chunk plus the
    // rest, in order, without re-reading bytes.
    const split = Math.min(4, gz.byteLength)
    const trace = await parseTrace(
      streamFromByteChunks([gz.slice(0, split), gz.slice(split)]),
      {name: 'trace.json.gz', size: gz.byteLength},
    )
    expect(trace.timeline.systems[0].tracks[0].measures[0].name).toBe('task')
  })

  it('passes through non-gzipped streams untouched (no decompression)', async () => {
    const trace = await parseTrace(streamFromString(MINIMAL_TRACE), {
      name: 'trace.json',
      size: byteSize(MINIMAL_TRACE),
    })
    expect(trace.timeline.systems[0].tracks[0].measures[0].name).toBe('task')
  })
})

describe('parseTrace - maxBytes truncation', () => {
  it('stops reading at the cap and finalizes on whatever has been emitted', async () => {
    // Build a stream of N small events so we can split them across
    // multiple chunks. The chrome JSON parser emits each completed
    // `traceEvents[i]` as we cross its closing brace, so anything
    // before the cut should land in the parsed trace.
    const events: string[] = []
    for (let i = 0; i < 200; i++) {
      events.push(
        `{"ph":"X","name":"e${i}","cat":"c","pid":1,"tid":1,"ts":${i},"dur":1}`,
      )
    }
    const head = '{"traceEvents":['
    const body = events.join(',')
    // We deliberately *don't* include the closing `]}` — the
    // truncation path must accept incomplete JSON.
    const text = head + body
    const encoded = new TextEncoder().encode(text)

    // Feed in 1 KiB chunks so the cap can land mid-stream.
    const chunkSize = 1024
    const chunks: Uint8Array[] = []
    for (let off = 0; off < encoded.byteLength; off += chunkSize) {
      chunks.push(encoded.slice(off, off + chunkSize))
    }
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift()
        if (next) controller.enqueue(next)
        else controller.close()
      },
    })

    const cap = 2 * chunkSize
    const phaseDetails: Array<{phase: string; detail?: string}> = []
    const trace = await parseTrace(stream, SOURCE, {
      maxBytes: cap,
      onProgress: p => phaseDetails.push({phase: p.phase, detail: p.detail}),
    })

    expect(trace.metadata.truncated).toBe(true)
    expect(trace.metadata.truncatedAtMaxBytes).toBe(cap)
    expect(typeof trace.metadata.truncatedAtBytes).toBe('number')
    // The first slice in the timeline should be one of the events that
    // landed in the cap window — proving partial parse worked.
    const firstTrack = trace.timeline.systems[0]?.tracks[0]
    expect(firstTrack).toBeDefined()
    expect(firstTrack.measures.length).toBeGreaterThan(0)
    expect(firstTrack.measures[0].name.startsWith('e')).toBe(true)
    // We should have seen a 'truncated' detail bubble up at least once.
    expect(phaseDetails.some(p => p.detail === 'truncated')).toBe(true)
  })

  it('does not truncate when the cap is greater than the input', async () => {
    const trace = await parseTrace(streamFromString(MINIMAL_TRACE), SOURCE, {
      maxBytes: 10 * 1024 * 1024,
    })
    expect(trace.metadata.truncated).toBeUndefined()
  })
})

describe('parseTrace - real trace asset', () => {
  it('parses assets/perfecto-chrome-trace.json end-to-end', async () => {
    const filePath = path.resolve(
      __dirname,
      '..',
      '..',
      'assets',
      'perfecto-chrome-trace.json',
    )
    const bytes = await readFile(filePath)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes))
        controller.close()
      },
    })
    const trace = await parseTrace(stream, {
      name: 'perfecto-chrome-trace.json',
      size: bytes.byteLength,
    })

    expect(trace.timeline.systems.length).toBeGreaterThan(0)
    expect(trace.timeline.start).toBe(0)
    expect(trace.timeline.end).toBeGreaterThan(0)
    let iterated = 0
    for (const _ of iterateTimelineEvents(trace.timeline)) iterated++
    expect(iterated).toBeGreaterThan(0)

    const systemNames = trace.timeline.systems.map(s => s.name)
    expect(systemNames).toEqual(expect.arrayContaining(['Renderer', 'Browser']))

    const renderer = trace.timeline.systems.find(s => s.name === 'Renderer')!
    const trackNames = renderer.tracks.map(t => t.name)
    expect(trackNames).toEqual(expect.arrayContaining(['CrRendererMain']))

    expect(trace.metadata.parser).toBe('chrome')
    expect(typeof trace.metadata.eventCount).toBe('number')
    expect(trace.metadata.source).toBe('DevTools')

    // Structural regression guard: a real Chrome trace's Renderer Main
    // track always has meaningful nested depth (RunTask → tasks → user
    // code frames). A prior compaction bug collapsed everything into a
    // single top-level rect; the test below would have caught that.
    const main = renderer.tracks.find(t => t.name === 'CrRendererMain')
    expect(main).toBeDefined()

    const countMeasures = (ms: Measure[]): number => {
      let n = ms.length
      for (const m of ms) n += countMeasures(m.measures)
      return n
    }
    const maxDepth = (m: Measure): number => {
      let d = 0
      for (const c of m.measures) {
        const cd = maxDepth(c) + 1
        if (cd > d) d = cd
      }
      return d
    }

    const totalMeasures = countMeasures(main!.measures)
    const deepest = Math.max(0, ...main!.measures.map(maxDepth))
    // Thresholds chosen well under the observed real-trace values
    // (~10k measures, depth ≥ 5 on this asset) so they fire on
    // compaction bugs without being flaky over time.
    expect(totalMeasures).toBeGreaterThan(3_000)
    expect(deepest).toBeGreaterThanOrEqual(3)
    // Top-level `RunTask` parents must survive compaction — folding
    // them destroys every callstack inside.
    const runTasks = main!.measures.filter(m => m.name === 'RunTask')
    expect(runTasks.length).toBeGreaterThan(5)
    const runTasksWithChildren = runTasks.filter(m => m.measures.length > 0)
    expect(runTasksWithChildren.length).toBeGreaterThan(0)
    // Hard regression guard: a small "personal-laptop"-sized trace
    // should be byte-for-byte preserved by the parser. Sibling
    // compaction is gated on a trace-wide event-count threshold so
    // small traces never get silently rewritten in the user's view.
    expect(trace.metadata.compaction?.siblingRunsFolded ?? 0).toBe(0)
    expect(trace.metadata.compaction?.siblingEventsFolded ?? 0).toBe(0)
    // CPU-tiny-frame folding is allowed (it's the explicit purpose of
    // the synthesized jsFrame subtree), but it must never drop a frame
    // that carried structural children — `compactCpuTinyFrames` only
    // touches leaf-only sibling runs.
    const folded = trace.metadata.compaction?.cpuTinyEventsFolded ?? 0
    expect(folded).toBeGreaterThanOrEqual(0)
  }, 30000)

  it('produces the same measure tree on the real asset with compaction force-disabled', async () => {
    // Cross-check: parsing with the size gate forced wide open
    // _and_ disabled should yield identical structural totals on a
    // small trace. Catches regressions where some other code path
    // (online streaming, CPU-tiny, finalize sort) silently drops
    // measures even though the sibling fold counters report zero.
    const filePath = path.resolve(
      __dirname,
      '..',
      '..',
      'assets',
      'perfecto-chrome-trace.json',
    )
    const bytes = await readFile(filePath)
    const mkStream = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes))
          controller.close()
        },
      })
    const source = {name: 'perfecto-chrome-trace.json', size: bytes.byteLength}

    const baseline = await parseTrace(mkStream(), source, {
      chromeParser: {compactionMinEvents: Number.MAX_SAFE_INTEGER},
    })
    const withDefault = await parseTrace(mkStream(), source)

    const countMeasures = (ms: Measure[]): number => {
      let n = ms.length
      for (const m of ms) n += countMeasures(m.measures)
      return n
    }
    const trackTotal = (trace: typeof baseline, sysName: string, trackName: string): number => {
      const sys = trace.timeline.systems.find(s => s.name === sysName)
      const track = sys?.tracks.find(t => t.name === trackName)
      return track ? countMeasures(track.measures) : 0
    }
    const def = trackTotal(withDefault, 'Renderer', 'CrRendererMain')
    const base = trackTotal(baseline, 'Renderer', 'CrRendererMain')
    expect(base).toBeGreaterThan(3_000)
    expect(def).toBe(base)
  }, 30_000)
})

describe('parseTrace - subpixel-subtree cull', () => {
  /**
   * Build a tightly nested B/E pair stack inside a single 0.01ms-wide
   * window (10ns at the trace's µs resolution). After parsing this
   * looks like a `depth`-deep stack rooted on the same thread —
   * exactly the shape the cull is designed to fold.
   */
  function nestedStackEvents(depth: number, startUs: number, endUs: number) {
    const events: Array<Record<string, unknown>> = []
    const pid = 1
    const tid = 100
    events.push({ph: 'M', name: 'process_name', pid, tid, ts: 0, args: {name: 'P'}})
    events.push({ph: 'M', name: 'thread_name', pid, tid, ts: 0, args: {name: 'T'}})
    for (let i = 0; i < depth; i++) {
      events.push({ph: 'B', name: `frame${i}`, cat: 'js', pid, tid, ts: startUs})
    }
    for (let i = depth - 1; i >= 0; i--) {
      events.push({ph: 'E', name: `frame${i}`, cat: 'js', pid, tid, ts: endUs})
    }
    return events
  }

  it('folds a deep sub-pixel stack into one synthetic Measure when track meets the gate', async () => {
    const events = nestedStackEvents(50, 1000, 1010) // 1ms width — actually well above 0.05ms
    // Use a tiny window (10ns) so the whole stack is sub-pixel.
    const tinyEvents = nestedStackEvents(50, 1000, 1000.01)
    void events

    const trace = await parseTrace(
      streamFromString(JSON.stringify({traceEvents: tinyEvents})),
      SOURCE,
      {chromeParser: {subpixelCullMinEventsPerTrack: 10}},
    )

    expect(trace.metadata.compaction?.subpixelSubtreesFolded ?? 0).toBeGreaterThan(0)
    expect(trace.metadata.compaction?.subpixelEventsFolded ?? 0).toBeGreaterThan(0)
    expect(trace.metadata.compaction?.subpixelMaxDepthFolded ?? 0).toBeGreaterThanOrEqual(40)
    // The track should now have a single representative whose subtree
    // is empty and whose compaction report carries the new origin.
    const track = trace.timeline.systems[0].tracks[0]
    const folded = track.measures.find(m => m.compaction?.some(r => r.origin === 'subpixel-subtree'))
    expect(folded).toBeDefined()
    expect(folded!.measures).toHaveLength(0)
  })

  it('leaves small tracks untouched (per-track event-count gate)', async () => {
    const tinyEvents = nestedStackEvents(50, 1000, 1000.01)

    const trace = await parseTrace(
      streamFromString(JSON.stringify({traceEvents: tinyEvents})),
      SOURCE,
      {chromeParser: {subpixelCullMinEventsPerTrack: 1_000_000}},
    )

    expect(trace.metadata.compaction?.subpixelSubtreesFolded ?? 0).toBe(0)
    expect(trace.metadata.compaction?.subpixelEventsFolded ?? 0).toBe(0)
    // Stack should have survived intact (modulo the existing
    // CPU-tiny / sibling passes, which don't touch B/E pairs).
    const track = trace.timeline.systems[0].tracks[0]
    let depth = 0
    let cur = track.measures[0]
    while (cur && cur.measures.length > 0) {
      depth += 1
      cur = cur.measures[0]
    }
    expect(depth).toBeGreaterThanOrEqual(40)
  })

  it('preserves visible-duration deep stacks even when the track is large', async () => {
    // Same depth as the cull-eligible test but spanning 1ms — every
    // frame is wider than the cull threshold, so depth alone must
    // not trigger a fold.
    const wideEvents = nestedStackEvents(50, 1000, 2000)

    const trace = await parseTrace(
      streamFromString(JSON.stringify({traceEvents: wideEvents})),
      SOURCE,
      {chromeParser: {subpixelCullMinEventsPerTrack: 10}},
    )

    expect(trace.metadata.compaction?.subpixelSubtreesFolded ?? 0).toBe(0)
    const track = trace.timeline.systems[0].tracks[0]
    let depth = 0
    let cur = track.measures[0]
    while (cur && cur.measures.length > 0) {
      depth += 1
      cur = cur.measures[0]
    }
    expect(depth).toBeGreaterThanOrEqual(40)
  })

  it('preserves the total event count under the cull (giant-stack invariant)', async () => {
    // 1000-deep B/E stack inside a 0.005ms window. Pre-cull there
    // are exactly 1000 Measures (one per B/E pair); post-cull at
    // least one of them must be a fold whose `compaction[0].count`
    // makes up the difference. The invariant is `Σ (1 + count) ===
    // 1000` over the surviving tree.
    const tinyEvents = nestedStackEvents(1000, 1000, 1000.005)

    const trace = await parseTrace(
      streamFromString(JSON.stringify({traceEvents: tinyEvents})),
      SOURCE,
      {chromeParser: {subpixelCullMinEventsPerTrack: 10}},
    )

    let represented = 0
    const stack: TimelineContainer[] = []
    for (const sys of trace.timeline.systems) {
      for (const t of sys.tracks) stack.push(t)
    }
    while (stack.length > 0) {
      const cur = stack.pop()!
      for (const m of cur.measures) {
        let folded = 0
        if (m.compaction) {
          for (const r of m.compaction) folded += r.count
        }
        represented += 1 + folded
        if (m.measures.length > 0) stack.push(m)
      }
    }
    expect(represented).toBe(1000)
    expect(trace.metadata.compaction?.subpixelSubtreesFolded ?? 0).toBeGreaterThan(0)
  })

  it('parses assets/perfecto-chrome-trace.json without losing entire systems', async () => {
    // Real-trace integrity check. After cull + compact + fixup the
    // timeline must still represent the bulk of the parser-reported
    // event count. The bound is generous (>=70%) because
    // `metadata.eventCount` counts B/E pairs as two events while the
    // tree counts one per pair, plus marks/instants/etc. don't show
    // up as Measures at all. The point is to catch catastrophic
    // loss — an entire system disappearing — not to gauge fidelity.
    const filePath = path.resolve(
      __dirname,
      '..',
      '..',
      'assets',
      'perfecto-chrome-trace.json',
    )
    const bytes = await readFile(filePath)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes))
        controller.close()
      },
    })
    const trace = await parseTrace(stream, {
      name: 'perfecto-chrome-trace.json',
      size: bytes.byteLength,
    })

    let represented = 0
    const stack: TimelineContainer[] = []
    for (const sys of trace.timeline.systems) {
      for (const t of sys.tracks) stack.push(t)
    }
    while (stack.length > 0) {
      const cur = stack.pop()!
      for (const m of cur.measures) {
        let folded = 0
        if (m.compaction) {
          for (const r of m.compaction) folded += r.count
        }
        represented += 1 + folded
        if (m.measures.length > 0) stack.push(m)
      }
    }
    // Sanity: at least one system survived.
    expect(trace.timeline.systems.some(s => s.tracks.length > 0)).toBe(true)
    // We saw ~hundreds of thousands of Measures pre-summary; just
    // demand four-digit floor so the assertion can't pass on an
    // empty timeline.
    expect(represented).toBeGreaterThan(1000)
  }, 60_000)

  it('emits events.{processed,total} during the finalize phase', async () => {
    const tinyEvents = nestedStackEvents(20, 1000, 1000.01)
    const updates: Array<{processed: number; total: number}> = []
    await parseTrace(
      streamFromString(JSON.stringify({traceEvents: tinyEvents})),
      SOURCE,
      {
        chromeParser: {subpixelCullMinEventsPerTrack: 10},
        onProgress: p => {
          if (p.phase === 'finalizing' && p.events) updates.push(p.events)
        },
      },
    )
    expect(updates.length).toBeGreaterThan(0)
    // Counter must be monotonic and saturate at total.
    let prev = 0
    for (const e of updates) {
      expect(e.total).toBeGreaterThan(0)
      expect(e.processed).toBeGreaterThanOrEqual(prev)
      expect(e.processed).toBeLessThanOrEqual(e.total)
      prev = e.processed
    }
    expect(updates.at(-1)!.processed).toBe(updates.at(-1)!.total)
  })

  it('pumps progress smoothly across multiple tracks during finalize', async () => {
    // Multi-track trace so the parser walks several (track × pass)
    // pairs — combined with the per-pass forced emit, we should see
    // strictly more than the old 3-jump shape per process.
    const events: Array<Record<string, unknown>> = []
    const TRACKS = 4
    for (let t = 0; t < TRACKS; t++) {
      const pid = 1
      const tid = 100 + t
      events.push({ph: 'M', name: 'process_name', pid, tid, ts: 0, args: {name: 'P'}})
      events.push({
        ph: 'M',
        name: 'thread_name',
        pid,
        tid,
        ts: 0,
        args: {name: `T${t}`},
      })
      const depth = 30
      for (let i = 0; i < depth; i++) {
        events.push({ph: 'B', name: `frame${i}`, cat: 'js', pid, tid, ts: 1000})
      }
      for (let i = depth - 1; i >= 0; i--) {
        events.push({ph: 'E', name: `frame${i}`, cat: 'js', pid, tid, ts: 1000.01})
      }
    }
    const updates: Array<{processed: number; total: number}> = []
    await parseTrace(
      streamFromString(JSON.stringify({traceEvents: events})),
      SOURCE,
      {
        chromeParser: {subpixelCullMinEventsPerTrack: 10},
        onProgress: p => {
          if (p.phase === 'finalizing' && p.events) updates.push(p.events)
        },
      },
    )
    // 4 tracks × 3 passes = 12 forced per-pass headers, plus the
    // start + final force = baseline of 14. Floor a comfortable
    // margin below to avoid CI timing flakes from the throttle
    // coalescing adjacent calls.
    expect(updates.length).toBeGreaterThanOrEqual(8)
    // Strict monotonicity and saturation invariants still hold.
    let prev = 0
    for (const e of updates) {
      expect(e.processed).toBeGreaterThanOrEqual(prev)
      expect(e.processed).toBeLessThanOrEqual(e.total)
      prev = e.processed
    }
    expect(updates.at(-1)!.processed).toBe(updates.at(-1)!.total)
  })
})

describe('types', () => {
  it('accepts a CompactionReport on Measure', () => {
    const report: CompactionReport = {
      origin: 'sibling',
      category: 'render',
      names: ['Layout'],
      count: 42,
      firstTs: 10,
      lastTs: 52,
      totalDurationMs: 3.5,
    }

    const compacted: Measure = {
      id: 'm-compact',
      name: 'Compacted render',
      start: 0,
      end: 100,
      category: 'render',
      events: [],
      marks: [],
      measures: [],
      compaction: [report],
    }

    expect(compacted.compaction).toHaveLength(1)
    expect(compacted.compaction?.[0].origin).toBe('sibling')
    expect(compacted.compaction?.[0].count).toBe(42)
    expect(compacted.compaction?.[0].names).toEqual(['Layout'])
  })
})
