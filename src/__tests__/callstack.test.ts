import type {Measure, RawEvent, Timeline, Track} from '../core'
import {buildSliceBuffers} from '../core/render/sliceBuffers'
import {
  isJsFrameSelection,
  resolveCallstack,
} from '../components/timeline/callstack'
import type {SliceRef} from '../components/timeline/selectionStore'

function jsFrameEvent(
  functionName: string,
  url?: string,
  lineNumber?: number,
  columnNumber?: number,
): RawEvent {
  return {
    ph: 'JS_FRAME',
    cat: 'disabled-by-default-v8.cpu_profiler',
    name: functionName,
    ts: 0,
    dur: 0,
    functionName,
    url,
    lineNumber,
    columnNumber,
    nodeId: 0,
  }
}

function jsFrame(
  id: string,
  start: number,
  end: number,
  functionName: string,
  children: Measure[] = [],
  url?: string,
  lineNumber?: number,
): Measure {
  return {
    id,
    name: functionName || '(anonymous)',
    start,
    end,
    category: 'jsFrame',
    events: [jsFrameEvent(functionName, url, lineNumber)],
    marks: [],
    measures: children,
  }
}

function host(
  id: string,
  name: string,
  start: number,
  end: number,
  children: Measure[] = [],
): Measure {
  return {
    id,
    name,
    start,
    end,
    category: 'scripting',
    events: [],
    marks: [],
    measures: children,
  }
}

function makeTimeline(measures: Measure[]): {timeline: Timeline; track: Track} {
  const track: Track = {
    id: 'main',
    name: 'Main Thread',
    marks: [],
    measures,
    buffers: buildSliceBuffers({marks: [], measures}),
  }
  const timeline: Timeline = {
    start: 0,
    end: 1000,
    systems: [{id: 'sys', name: 'sys', tracks: [track]}],
  }
  return {timeline, track}
}

describe('resolveCallstack', () => {
  it('returns an empty result when no ref is provided', () => {
    const {timeline} = makeTimeline([jsFrame('a', 0, 10, 'foo')])
    const out = resolveCallstack(timeline, null)
    expect(out.frames).toEqual([])
    expect(out.leafIndex).toBe(-1)
    expect(out.track).toBeNull()
    expect(isJsFrameSelection(out)).toBe(false)
  })

  it('reconstructs a root-to-leaf chain of JS frames via measureId', () => {
    const leaf = jsFrame('leaf', 2, 5, 'inner', [], 'https://x/a.js', 12)
    const mid = jsFrame('mid', 1, 8, 'outer', [leaf], 'https://x/a.js', 3)
    const root = jsFrame('root', 0, 10, '(root)', [mid])
    const {timeline} = makeTimeline([root])

    const ref: SliceRef = {
      trackId: 'main',
      startMs: 2,
      endMs: 5,
      depth: 2,
      measureId: 'leaf',
    }
    const out = resolveCallstack(timeline, ref)

    expect(out.frames.map(f => f.measure.id)).toEqual(['root', 'mid', 'leaf'])
    expect(out.leafIndex).toBe(2)
    expect(out.frames.every(f => f.isJsFrame)).toBe(true)
    expect(out.frames[2].functionName).toBe('inner')
    expect(out.frames[2].url).toBe('https://x/a.js')
    expect(out.frames[2].lineNumber).toBe(12)
    expect(isJsFrameSelection(out)).toBe(true)
  })

  it('falls back to bounds+depth when measureId is absent', () => {
    const leaf = jsFrame('leaf', 2, 5, 'inner')
    const root = jsFrame('root', 0, 10, 'outer', [leaf])
    const {timeline} = makeTimeline([root])

    const ref: SliceRef = {trackId: 'main', startMs: 2, endMs: 5, depth: 1}
    const out = resolveCallstack(timeline, ref)
    expect(out.frames.map(f => f.measure.id)).toEqual(['root', 'leaf'])
  })

  it('preserves non-JS-frame ancestors in the chain but marks them', () => {
    const leaf = jsFrame('leaf', 2, 5, 'inner')
    const hostMeasure = host('h', 'FunctionCall', 1, 8, [leaf])
    const {timeline} = makeTimeline([hostMeasure])

    const ref: SliceRef = {
      trackId: 'main',
      startMs: 2,
      endMs: 5,
      depth: 1,
      measureId: 'leaf',
    }
    const out = resolveCallstack(timeline, ref)
    expect(out.frames.map(f => f.measure.id)).toEqual(['h', 'leaf'])
    expect(out.frames.map(f => f.isJsFrame)).toEqual([false, true])
    expect(isJsFrameSelection(out)).toBe(true)
  })

  it('returns no callstack when the selected leaf is not a JS frame', () => {
    const hostMeasure = host('h', 'Layout', 0, 10)
    const {timeline} = makeTimeline([hostMeasure])

    const ref: SliceRef = {
      trackId: 'main',
      startMs: 0,
      endMs: 10,
      depth: 0,
      measureId: 'h',
    }
    const out = resolveCallstack(timeline, ref)
    expect(out.frames).toHaveLength(1)
    expect(isJsFrameSelection(out)).toBe(false)
  })

  it('returns an empty result when the track cannot be found', () => {
    const {timeline} = makeTimeline([jsFrame('a', 0, 10, 'foo')])
    const out = resolveCallstack(timeline, {
      trackId: 'nope',
      startMs: 0,
      endMs: 10,
      depth: 0,
      measureId: 'a',
    })
    expect(out.frames).toEqual([])
    expect(out.leafIndex).toBe(-1)
  })
})
