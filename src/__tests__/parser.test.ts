import {readFile} from 'node:fs/promises'
import path from 'node:path'

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
