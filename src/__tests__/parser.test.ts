import {readFile} from 'node:fs/promises'
import path from 'node:path'

import {parseTrace} from '../core/parser'
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

    const idsFromEvents = new Set(trace.events.map(e => e.id))
    expect(idsFromEvents).toEqual(idsFromTree)
    expect(trace.events.length).toBeGreaterThan(0)
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
    expect(trace.events.length).toBeGreaterThan(0)

    const systemNames = trace.timeline.systems.map(s => s.name)
    expect(systemNames).toEqual(expect.arrayContaining(['Renderer', 'Browser']))

    const renderer = trace.timeline.systems.find(s => s.name === 'Renderer')!
    const trackNames = renderer.tracks.map(t => t.name)
    expect(trackNames).toEqual(expect.arrayContaining(['CrRendererMain']))

    expect(trace.metadata.parser).toBe('chrome')
    expect(typeof trace.metadata.eventCount).toBe('number')
    expect(trace.metadata.source).toBe('DevTools')
  }, 30000)
})

describe('types', () => {
  it('accepts a CompactionReport on Measure', () => {
    const report: CompactionReport = {
      category: 'render',
      names: ['Layout', 'Paint'],
      fraction: 0.75,
      events: [
        {phase: 'B', ts: 10},
        {phase: 'E', ts: 42},
      ],
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
    expect(compacted.compaction?.[0].fraction).toBeCloseTo(0.75)
    expect(compacted.compaction?.[0].names).toEqual(['Layout', 'Paint'])
    expect(compacted.compaction?.[0].events).toHaveLength(2)
  })
})
