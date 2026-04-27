import {render, screen} from '@testing-library/react'
import {act} from 'react'
import type {Measure, Timeline, Track} from '../core'
import {buildSliceBuffers} from '../core/render/sliceBuffers'
import Aggregator from '../components/Aggregator'
import {createSelectionStore} from '../components/timeline/selectionStore'

function jsFrame(
  id: string,
  start: number,
  end: number,
  fn: string,
  children: Measure[] = [],
  lineNumber?: number,
): Measure {
  const label = fn || '(anonymous)'
  return {
    id,
    name: label,
    start,
    end,
    category: 'jsFrame',
    events: [],
    marks: [],
    measures: children,
    attribution: {
      kind: 'callsite',
      source: 'v8-cpu-profile',
      label,
      location: {url: 'https://x/a.js', lineNumber},
    },
  }
}

function pyFrame(
  id: string,
  start: number,
  end: number,
  label: string,
  children: Measure[] = [],
  location?: {url: string; lineNumber?: number},
): Measure {
  return {
    id,
    name: label,
    start,
    end,
    category: 'python_function',
    events: [],
    marks: [],
    measures: children,
    attribution: {
      kind: 'callsite',
      source: 'kineto-python',
      label,
      location,
    },
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

  it('renders root → leaf callsite frames when an attributed slice is selected', () => {
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

  it('renders a Python callstack when a kineto-python frame is selected', () => {
    const leaf = pyFrame('leaf', 2, 5, 'compile_fx', [], {
      url: 'torch/_inductor/compile_fx.py',
      lineNumber: 123,
    })
    const root = pyFrame('root', 0, 10, '_run_module_as_main', [leaf], {
      url: 'runpy.py',
      lineNumber: 196,
    })
    const {timeline} = makeTimeline([root])
    const store = createSelectionStore()

    render(<Aggregator selectionStore={store} timeline={timeline} />)

    act(() => {
      store.setSelectedSlice({
        trackId: 'main',
        startMs: 2,
        endMs: 5,
        depth: 1,
        measureId: 'leaf',
      })
    })

    const list = screen.getByTestId('aggregator-callstack-list')
    const items = Array.from(list.querySelectorAll('li'))
    expect(items.map(li => li.textContent)).toEqual([
      expect.stringContaining('_run_module_as_main'),
      expect.stringContaining('compile_fx'),
    ])
    // Source location is surfaced under the label so users can jump to
    // file:line for a Python frame, just like for V8.
    const leafEl = list.querySelector('[data-leaf="true"]')
    expect(leafEl?.textContent).toContain('compile_fx')
    expect(leafEl?.textContent).toContain('torch/_inductor/compile_fx.py:123')
  })

  it('does not render the callstack when the selected slice has no callsite attribution', () => {
    const unattributed: Measure = {
      id: 'layout',
      name: 'Layout',
      start: 0,
      end: 10,
      category: 'rendering',
      events: [],
      marks: [],
      measures: [],
    }
    const {timeline} = makeTimeline([unattributed])
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
