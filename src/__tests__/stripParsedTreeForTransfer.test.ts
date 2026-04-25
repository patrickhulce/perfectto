import {parseTrace} from '../core/parser'
import {stripParsedTreeForTransfer} from '../orchestration/transferables'

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

const NESTED_TRACE = JSON.stringify({
  traceEvents: [
    {ph: 'B', name: 'A', cat: 'c', pid: 1, tid: 1, ts: 0},
    {ph: 'B', name: 'B', cat: 'c', pid: 1, tid: 1, ts: 1},
    {ph: 'B', name: 'C', cat: 'c', pid: 1, tid: 1, ts: 2},
    {ph: 'E', name: 'C', cat: 'c', pid: 1, tid: 1, ts: 3},
    {ph: 'E', name: 'B', cat: 'c', pid: 1, tid: 1, ts: 4},
    {ph: 'E', name: 'A', cat: 'c', pid: 1, tid: 1, ts: 5},
  ],
})

describe('stripParsedTreeForTransfer', () => {
  it('clears the recursive tree but preserves the flat buffers', async () => {
    const trace = await parseTrace(streamFromString(NESTED_TRACE), SOURCE)
    const track = trace.timeline.systems[0].tracks[0]
    // Sanity: tree is populated pre-strip and we have buffers.
    expect(track.measures.length).toBeGreaterThan(0)
    expect(track.measures[0].measures.length).toBeGreaterThan(0)
    expect(track.buffers).toBeDefined()
    const preCount = track.buffers!.count
    expect(preCount).toBeGreaterThan(2)
    // Capture references to inner Measures via the flat buffer; after
    // strip those same objects should be reachable with empty `measures`.
    const innerRef = track.buffers!.measures[1]
    expect(innerRef.measures.length).toBeGreaterThanOrEqual(1)

    stripParsedTreeForTransfer(trace)

    expect(track.measures).toEqual([])
    expect(track.marks).toEqual([])
    expect(innerRef.measures).toEqual([])
    expect(innerRef.marks).toEqual([])
    // Flat buffers — the only path the main thread reads — survive.
    expect(track.buffers!.count).toBe(preCount)
    expect(track.buffers!.measures[1]).toBe(innerRef)
    expect(innerRef.name).toBe('B')
    expect(innerRef.start).toBeGreaterThanOrEqual(0)
  })

  it('is safe to call on a trace whose tracks have no slices', async () => {
    const empty = JSON.stringify({traceEvents: []})
    const trace = await parseTrace(streamFromString(empty), SOURCE)
    expect(() => stripParsedTreeForTransfer(trace)).not.toThrow()
  })
})
