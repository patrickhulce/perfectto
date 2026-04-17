import { parseTrace } from '../core/parser'
import type {
  CompactionReport,
  Measure,
  ParseProgress,
  TimelineContainer,
} from '../core'

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
  const queue = chunks.map((c) => encoder.encode(c))
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
  })
}

describe('parseTrace', () => {
  const source = { name: 'trace.json', size: 123 }

  it('returns a ParsedTrace with at least one system, track, and measure', async () => {
    const trace = await parseTrace(streamFromString('{}'), source)

    expect(trace.source).toEqual(source)
    expect(trace.timeline.systems.length).toBeGreaterThanOrEqual(1)

    const firstTrack = trace.timeline.systems[0].tracks[0]
    expect(firstTrack).toBeDefined()
    expect(firstTrack.measures.length + firstTrack.marks.length).toBeGreaterThan(0)

    const totalMeasures = trace.timeline.systems.reduce(
      (acc, system) =>
        acc + system.tracks.reduce((a, t) => a + t.measures.length, 0),
      0,
    )
    expect(totalMeasures).toBeGreaterThanOrEqual(1)
  })

  it('flattens every mark and measure (including nested) into events', async () => {
    const trace = await parseTrace(streamFromString(''), source)

    const idsFromTree = new Set<string>()
    const walk = (container: TimelineContainer) => {
      for (const m of container.marks) idsFromTree.add(m.id)
      for (const m of container.measures) {
        idsFromTree.add(m.id)
        walk(m)
      }
    }
    for (const system of trace.timeline.systems) {
      for (const track of system.tracks) walk(track)
    }

    const idsFromEvents = new Set(trace.events.map((e) => e.id))
    expect(idsFromEvents).toEqual(idsFromTree)
    expect(trace.events.length).toBeGreaterThan(0)
  })

  it('populates metadata as an object', async () => {
    const trace = await parseTrace(streamFromString(''), source)
    expect(typeof trace.metadata).toBe('object')
    expect(trace.metadata).not.toBeNull()
  })

  it('accepts an async iterable of streams and sums bytes across them', async () => {
    const a = 'first-stream-payload'
    const b = 'second-stream'
    const totalBytes = new TextEncoder().encode(a).byteLength +
      new TextEncoder().encode(b).byteLength

    async function* gen(): AsyncGenerator<ReadableStream<Uint8Array>> {
      yield streamFromString(a)
      yield streamFromString(b)
    }

    const events: ParseProgress[] = []
    const trace = await parseTrace(gen(), source, {
      onProgress: (p) => events.push(p),
    })

    expect(trace).toBeDefined()
    expect(events.length).toBeGreaterThan(0)
    const last = events[events.length - 1]
    expect(last.phase).toBe('done')
    expect(last.bytesRead).toBe(totalBytes)
    expect(events.some((e) => e.streamIndex === 1)).toBe(true)
  })

  it('emits a final progress event with phase=done and bytesRead equal to stream size', async () => {
    const payload = 'hello world, this is a trace chunk'
    const total = new TextEncoder().encode(payload).byteLength

    const events: ParseProgress[] = []
    await parseTrace(streamFromString(payload), source, {
      onProgress: (p) => events.push(p),
    })

    const last = events[events.length - 1]
    expect(last.phase).toBe('done')
    expect(last.bytesRead).toBe(total)
  })

  it('aborts mid-stream via AbortSignal', async () => {
    const controller = new AbortController()
    const chunks = ['alpha', 'beta', 'gamma', 'delta']

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
    const promise = parseTrace(stream, source, {
      signal: controller.signal,
      onProgress: (p) => {
        events.push(p)
        if (events.length === 1) controller.abort()
      },
    })

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })

    const countAtAbort = events.length
    await new Promise((r) => setTimeout(r, 10))
    expect(events.length).toBe(countAtAbort)
    expect(events.every((e) => e.phase !== 'done')).toBe(true)
  })

  it('rejects immediately when given an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      parseTrace(streamFromString('x'), source, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('handles multi-chunk streams and accumulates bytesRead', async () => {
    const chunks = ['aaaa', 'bbbb', 'cccc']
    const total = chunks.reduce(
      (n, c) => n + new TextEncoder().encode(c).byteLength,
      0,
    )

    const events: ParseProgress[] = []
    await parseTrace(streamFromChunks(chunks), source, {
      onProgress: (p) => events.push(p),
    })

    const last = events[events.length - 1]
    expect(last.bytesRead).toBe(total)
    expect(last.phase).toBe('done')
  })

  it('accepts a CompactionReport on Measure', () => {
    const report: CompactionReport = {
      category: 'render',
      names: ['Layout', 'Paint'],
      fraction: 0.75,
      events: [
        { phase: 'B', ts: 10 },
        { phase: 'E', ts: 42 },
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
