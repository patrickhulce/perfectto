import {useEffect, useRef, type RefObject} from 'react'
import {act, renderHook} from '@testing-library/react'
import {useTimelineZoom} from '../components/timeline/useTimelineViewport'
import {SelectionStore} from '../components/timeline/selectionStore'
import {createViewportStore} from '../components/timeline/viewportStore'
import {InputBindingsStore} from '../components/timeline/inputBindingsStore'
import {PRESET_DEFAULT} from '../components/timeline/inputPresets'

/**
 * Verifies the layered Esc behavior in `useTimelineZoom`'s key
 * dispatcher: each press peels one selection layer (in-progress drag →
 * committed range → sticky slice) instead of nuking everything at
 * once. Hovered slices are pointer-driven and intentionally don't
 * participate.
 */

interface Harness {
  scroller: HTMLElement
  eventSurface: HTMLElement
  selectionStore: SelectionStore
}

function makeHarness(): Harness {
  const scroller = document.createElement('div')
  Object.defineProperty(scroller, 'getBoundingClientRect', {
    value: () => ({
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  })
  const eventSurface = document.createElement('div')
  scroller.appendChild(eventSurface)
  document.body.appendChild(scroller)
  return {scroller, eventSurface, selectionStore: new SelectionStore()}
}

function mountHook(h: Harness): {unmount: () => void} {
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
  const bindingsStore = new InputBindingsStore(
    {
      activePresetId: PRESET_DEFAULT.id,
      bindings: {...PRESET_DEFAULT.bindings},
      customPresets: [],
    },
    null,
  )
  const view = renderHook(() => {
    const scrollerRef = useRef(h.scroller) as RefObject<HTMLElement | null>
    const result = useTimelineZoom({
      bounds: {start: 0, end: 100},
      labelWidthPx: 0,
      containerWidthPx: 800,
      scrollerRef,
      store: viewportStore,
      selectionStore: h.selectionStore,
      bindingsStore,
    })
    // The hook attaches its keydown listener only after a target is
    // mounted via `eventTargetRef` (it triggers `setEventEl`). Wire
    // it up once on mount; calling it directly during render would
    // loop on the resulting state update.
    useEffect(() => {
      result.eventTargetRef(h.eventSurface)
      return () => {
        result.eventTargetRef(null)
      }
    }, [result])
    return result
  })
  return {unmount: view.unmount}
}

function pressEscape(): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}),
    )
  })
}

describe('useTimelineZoom — layered Esc', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('cancels an in-progress drag before clearing anything else', () => {
    const h = makeHarness()
    h.selectionStore.setInProgress({startMs: 10, endMs: 30, anchorMs: 10})
    h.selectionStore.setCommitted({startMs: 50, endMs: 60})
    h.selectionStore.setSelectedSlice({trackId: 't', startMs: 5, endMs: 9, depth: 0})
    const {unmount} = mountHook(h)

    pressEscape()

    const state = h.selectionStore.get()
    expect(state.inProgress).toBeNull()
    expect(state.committed).not.toBeNull()
    expect(state.selectedSlice).not.toBeNull()
    unmount()
  })

  it('clears the committed range when no drag is in progress', () => {
    const h = makeHarness()
    h.selectionStore.setCommitted({startMs: 50, endMs: 60})
    h.selectionStore.setSelectedSlice({trackId: 't', startMs: 5, endMs: 9, depth: 0})
    const {unmount} = mountHook(h)

    pressEscape()

    const state = h.selectionStore.get()
    expect(state.committed).toBeNull()
    expect(state.selectedSlice).not.toBeNull()
    unmount()
  })

  it('clears the sticky slice when range and drag are already empty', () => {
    const h = makeHarness()
    h.selectionStore.setSelectedSlice({trackId: 't', startMs: 5, endMs: 9, depth: 0})
    const {unmount} = mountHook(h)

    pressEscape()

    expect(h.selectionStore.get().selectedSlice).toBeNull()
    unmount()
  })

  it('peels layers across successive presses (drag → range → slice)', () => {
    const h = makeHarness()
    h.selectionStore.setInProgress({startMs: 10, endMs: 30, anchorMs: 10})
    h.selectionStore.setCommitted({startMs: 50, endMs: 60})
    h.selectionStore.setSelectedSlice({trackId: 't', startMs: 5, endMs: 9, depth: 0})
    const {unmount} = mountHook(h)

    pressEscape()
    expect(h.selectionStore.get().inProgress).toBeNull()
    expect(h.selectionStore.get().committed).not.toBeNull()

    pressEscape()
    expect(h.selectionStore.get().committed).toBeNull()
    expect(h.selectionStore.get().selectedSlice).not.toBeNull()

    pressEscape()
    expect(h.selectionStore.get().selectedSlice).toBeNull()
    unmount()
  })
})
