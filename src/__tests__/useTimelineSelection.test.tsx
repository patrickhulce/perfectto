import {useRef, type RefObject} from 'react'
import {renderHook} from '@testing-library/react'
import {useTimelineSelection} from '../components/timeline/useTimelineSelection'
import {SelectionStore} from '../components/timeline/selectionStore'
import {createViewportStore} from '../components/timeline/viewportStore'
import {InputBindingsStore} from '../components/timeline/inputBindingsStore'
import {PRESET_DEFAULT, PRESET_PERFETTO} from '../components/timeline/inputPresets'
import type {HoverTrackLayout} from '../components/timeline/useTimelineHover'
import {buildSliceBuffers} from '../core/render/sliceBuffers'
import type {Measure, Track} from '../core'

/**
 * End-to-end smoke tests for the click-to-select-slice path in
 * useTimelineSelection. These mount the hook in a real DOM, dispatch
 * PointerEvents, and assert on the selection store — exercising the
 * actual listener wiring instead of trusting an internal refactor.
 *
 * They're narrow by design: they don't cover range-drag semantics (the
 * existing canvas2d / selectionStore tests already cover that layer),
 * just the brand-new "click-to-select works on EVERY preset" contract
 * that prompted the refactor.
 */

function m(id: string, start: number, end: number, children: Measure[] = []): Measure {
  return {id, name: id, start, end, events: [], marks: [], measures: children}
}

function track(measures: Measure[]): Track {
  return {id: 't-main', name: 't-main', marks: [], measures}
}

interface Harness {
  scroller: HTMLElement
  eventSurface: HTMLElement
  overview: HTMLCanvasElement
  selectionStore: SelectionStore
  viewportStore: ReturnType<typeof createViewportStore>
  trackRows: HoverTrackLayout[]
}

function makeHarness(): Harness {
  const scroller = document.createElement('div')
  // getBoundingClientRect is a no-op stub in jsdom; pin it so our
  // clientX/Y → ms math lands on predictable values.
  Object.defineProperty(scroller, 'getBoundingClientRect', {
    value: () => ({top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({})}),
  })
  const eventSurface = document.createElement('div')
  const overview = document.createElement('canvas')
  scroller.appendChild(eventSurface)
  scroller.appendChild(overview)
  document.body.appendChild(scroller)

  const selectionStore = new SelectionStore()
  const viewportStore = createViewportStore({
    timelineStart: 0,
    timelineEnd: 100,
    scrollLeft: 0,
    scrollTop: 0,
    pxPerMs: 4,
    labelWidthPx: 0,
    viewportWidth: 800,
    viewportHeight: 600,
  })

  const anchor = m('anchor', 0, 50, [m('child', 10, 40)])
  const sibling = m('sibling', 60, 90)
  const t = track([anchor, sibling])
  const buffers = buildSliceBuffers(t)
  const trackRows: HoverTrackLayout[] = [
    {track: {...t, buffers}, topPx: 0, heightPx: 20, expanded: true},
  ]

  return {scroller, eventSurface, overview, selectionStore, viewportStore, trackRows}
}

function mountHook(h: Harness, presetId: 'default' | 'perfetto') {
  const preset = presetId === 'perfetto' ? PRESET_PERFETTO : PRESET_DEFAULT
  const bindingsStore = new InputBindingsStore(
    {
      activePresetId: preset.id,
      bindings: {...preset.bindings},
      customPresets: [],
    },
    null,
  )
  const tooltip = document.createElement('div')
  return renderHook(() => {
    const scrollerRef = useRef(h.scroller) as RefObject<HTMLElement | null>
    const eventTargetRef = useRef(h.eventSurface) as RefObject<HTMLElement | null>
    const overviewCanvasRef = useRef(h.overview) as RefObject<HTMLCanvasElement | null>
    const tooltipRef = useRef(tooltip) as RefObject<HTMLElement | null>
    useTimelineSelection({
      scrollerRef,
      eventTargetRef,
      overviewCanvasRef,
      store: h.viewportStore,
      selectionStore: h.selectionStore,
      tooltipRef,
      trackRows: h.trackRows,
      bindingsStore,
    })
    return null
  })
}

/**
 * Dispatch a minimal pointerdown→pointerup pair on `eventSurface` at
 * `(clientX, clientY)` with zero movement — i.e. a click. jsdom doesn't
 * ship a `PointerEvent` constructor, so we synthesize one by tacking
 * the pointer-specific fields onto a plain `Event`. The hook only
 * reads `button`, `pointerId`, `clientX`, `clientY`, `target`, and
 * `ctrlKey`/`shiftKey`/etc., which `Event`/the assigned fields cover.
 */
function makePointerEvent(type: string, clientX: number, clientY: number): Event {
  const e = new Event(type, {bubbles: true, cancelable: true}) as Event & Record<string, unknown>
  Object.assign(e, {
    pointerId: 7,
    button: 0,
    buttons: 1,
    clientX,
    clientY,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
  })
  return e
}

function clickAt(eventSurface: HTMLElement, clientX: number, clientY: number): void {
  eventSurface.dispatchEvent(makePointerEvent('pointerdown', clientX, clientY))
  eventSurface.dispatchEvent(makePointerEvent('pointerup', clientX, clientY))
}

describe('useTimelineSelection — click-to-select slice', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('selects the clicked slice on the default preset (leftDrag=panHorizontal)', () => {
    const h = makeHarness()
    const {unmount} = mountHook(h, 'default')
    // Anchor slice is [0,50] at pxPerMs=4 → [0px, 200px] in the scroller.
    // Click at clientX=100 (ms=25), clientY=10 (inside row 0).
    clickAt(h.eventSurface, 100, 10)
    const sel = h.selectionStore.get().selectedSlice
    expect(sel).not.toBeNull()
    expect(sel?.startMs).toBeCloseTo(0)
    expect(sel?.endMs).toBeCloseTo(50)
    // measureId is populated so the aggregator can resolve the exact slice
    // even when two measures share the same [start, end, depth] tuple.
    expect(sel?.measureId).toBe('anchor')
    unmount()
  })

  it('selects the clicked slice on the perfetto preset (leftDrag=selectRange)', () => {
    const h = makeHarness()
    const {unmount} = mountHook(h, 'perfetto')
    clickAt(h.eventSurface, 100, 10)
    const sel = h.selectionStore.get().selectedSlice
    expect(sel).not.toBeNull()
    expect(sel?.startMs).toBeCloseTo(0)
    unmount()
  })

  it('clears the slice selection when the click lands on empty space', () => {
    const h = makeHarness()
    h.selectionStore.setSelectedSlice({trackId: 't-main', startMs: 0, endMs: 50, depth: 0})
    const {unmount} = mountHook(h, 'default')
    // Click at ms=95 (inside sibling [60,90]? no — 95 is past sibling's end,
    // falls into empty space on row 0 → hit-test returns null).
    clickAt(h.eventSurface, 380, 10)
    expect(h.selectionStore.get().selectedSlice).toBeNull()
    unmount()
  })
})
