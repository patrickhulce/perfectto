import {render, screen} from '@testing-library/react'
import {act} from 'react'
import type {Measure, RawEvent, Timeline, Track} from '../core'
import {buildSliceBuffers} from '../core/render/sliceBuffers'
import Aggregator from '../components/Aggregator'
import {createSelectionStore} from '../components/timeline/selectionStore'

function jsFrameEvent(fn: string, line?: number): RawEvent {
  return {
    ph: 'JS_FRAME',
    name: fn,
    ts: 0,
    dur: 0,
    functionName: fn,
    url: 'https://x/a.js',
    lineNumber: line,
    nodeId: 0,
  }
}

function jsFrame(
  id: string,
  start: number,
  end: number,
  fn: string,
  children: Measure[] = [],
  line?: number,
): Measure {
  return {
    id,
    name: fn || '(anonymous)',
    start,
    end,
    category: 'jsFrame',
    events: [jsFrameEvent(fn, line)],
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
    end: 100,
    systems: [{id: 'sys', name: 'sys', tracks: [track]}],
  }
  return {timeline, track}
}

describe('Aggregator — callstack view', () => {
  it('does not render the callstack when nothing is selected', () => {
    const {timeline} = makeTimeline([jsFrame('a', 0, 10, 'foo')])
    const store = createSelectionStore()
    render(<Aggregator selectionStore={store} timeline={timeline} />)
    expect(screen.queryByTestId('aggregator-callstack')).toBeNull()
  })

  it('renders root → leaf JS frames when a JS slice is selected', () => {
    const leaf = jsFrame('leaf', 2, 5, 'render', [], 42)
    const mid = jsFrame('mid', 1, 8, 'dispatch', [leaf])
    const root = jsFrame('root', 0, 10, '(root)', [mid])
    const {timeline} = makeTimeline([root])
    const store = createSelectionStore()

    render(<Aggregator selectionStore={store} timeline={timeline} />)

    act(() => {
      store.setSelectedSlice({
        trackId: 'main',
        startMs: 2,
        endMs: 5,
        depth: 2,
        measureId: 'leaf',
      })
    })

    const list = screen.getByTestId('aggregator-callstack-list')
    const items = list.querySelectorAll('li')
    expect(Array.from(items).map(li => li.textContent)).toEqual([
      expect.stringContaining('(root)'),
      expect.stringContaining('dispatch'),
      expect.stringContaining('render'),
    ])
    // Leaf is emphasized so users can see what they clicked.
    const leafEl = list.querySelector('[data-leaf="true"]')
    expect(leafEl?.textContent).toContain('render')
  })

  it('does not render the callstack when the selected slice is not a JS frame', () => {
    const nonJs: Measure = {
      id: 'layout',
      name: 'Layout',
      start: 0,
      end: 10,
      category: 'rendering',
      events: [],
      marks: [],
      measures: [],
    }
    const {timeline} = makeTimeline([nonJs])
    const store = createSelectionStore()
    render(<Aggregator selectionStore={store} timeline={timeline} />)

    act(() => {
      store.setSelectedSlice({
        trackId: 'main',
        startMs: 0,
        endMs: 10,
        depth: 0,
        measureId: 'layout',
      })
    })

    expect(screen.queryByTestId('aggregator-callstack')).toBeNull()
  })
})
