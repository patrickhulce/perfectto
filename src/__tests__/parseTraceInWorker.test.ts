import {parseTraceInWorker} from '../orchestration/parseTraceInWorker'

const MINIMAL_TRACE = JSON.stringify({
  traceEvents: [{ph: 'X', name: 'task', cat: 'test', pid: 1, tid: 1, ts: 0, dur: 10}],
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

describe('parseTraceInWorker', () => {
  const originalWorker = (globalThis as {Worker?: unknown}).Worker

  afterEach(() => {
    if (originalWorker === undefined) {
      delete (globalThis as {Worker?: unknown}).Worker
    } else {
      ;(globalThis as {Worker?: unknown}).Worker = originalWorker
    }
  })

  it('parses a trace (fallback path when Worker is unavailable)', async () => {
    delete (globalThis as {Worker?: unknown}).Worker

    const trace = await parseTraceInWorker(streamFromString(MINIMAL_TRACE), {
      name: 'trace.json',
      size: MINIMAL_TRACE.length,
    })

    expect(trace.source.name).toBe('trace.json')
    expect(trace.timeline.systems.length).toBeGreaterThanOrEqual(1)
    const firstTrack = trace.timeline.systems[0].tracks[0]
    expect(firstTrack.measures[0]?.name).toBe('task')
  })

  it('forwards progress events', async () => {
    delete (globalThis as {Worker?: unknown}).Worker

    const phases: string[] = []
    await parseTraceInWorker(
      streamFromString(MINIMAL_TRACE),
      {name: 'trace.json', size: MINIMAL_TRACE.length},
      {
        onProgress: p => {
          if (!phases.includes(p.phase)) phases.push(p.phase)
        },
      },
    )

    expect(phases).toContain('parsing')
    expect(phases).toContain('done')
  })

  it('honors an already-aborted signal', async () => {
    delete (globalThis as {Worker?: unknown}).Worker

    const controller = new AbortController()
    controller.abort(new DOMException('stop', 'AbortError'))

    await expect(
      parseTraceInWorker(
        streamFromString(MINIMAL_TRACE),
        {name: 'trace.json', size: MINIMAL_TRACE.length},
        {signal: controller.signal},
      ),
    ).rejects.toMatchObject({name: 'AbortError'})
  })
})
