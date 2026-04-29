import {useEffect, useRef, type RefObject} from 'react'
import {act, renderHook} from '@testing-library/react'
import {useTimelineZoom} from '../components/timeline/useTimelineViewport'
import {
  createPaneSelectionView,
  createSelectionStore,
  type PaneSelectionView,
  type SelectionStore,
} from '../components/timeline/selectionStore'
import {createViewportStore, type ViewportStore} from '../components/timeline/viewportStore'
import {createHoveredPaneStore, type HoveredPaneStore} from '../components/timeline/hoveredPaneStore'
import {InputBindingsStore} from '../components/timeline/inputBindingsStore'
import {PRESET_DEFAULT} from '../components/timeline/inputPresets'

/**
 * Multi-pane comparison view: verifies that the global key handler in
 * `useTimelineZoom` only fires for the pane the cursor is currently
 * over (per `hoveredPaneStore`), and that the per-pane
 * `PaneSelectionView` correctly enforces single-pane ownership of the
 * shared selection store across click / hover writes.
 */

interface PaneHarness {
  paneId: string
  scroller: HTMLElement
  eventSurface: HTMLElement
  viewportStore: ViewportStore
  view: PaneSelectionView
}

interface Setup {
  global: SelectionStore
  hoveredPaneStore: HoveredPaneStore
  bindings: InputBindingsStore
  paneA: PaneHarness
  paneB: PaneHarness
}

function makeHarness(
  paneId: string,
  global: SelectionStore,
): PaneHarness {
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
  return {
    paneId,
    scroller,
    eventSurface,
    viewportStore: createViewportStore({
      timelineStart: 0,
      timelineEnd: 100,
      scrollLeft: 0,
      scrollTop: 0,
      pxPerMs: 4,
      labelWidthPx: 0,
      viewportWidth: 800,
      viewportHeight: 600,
    }),
    view: createPaneSelectionView(global, paneId),
  }
}

function setupTwoPanes(): Setup {
  const global = createSelectionStore()
  const hoveredPaneStore = createHoveredPaneStore()
  const bindings = new InputBindingsStore(
    {
      activePresetId: PRESET_DEFAULT.id,
      bindings: {...PRESET_DEFAULT.bindings},
      customPresets: [],
    },
    null,
  )
  return {
    global,
    hoveredPaneStore,
    bindings,
    paneA: makeHarness('pane-A', global),
    paneB: makeHarness('pane-B', global),
  }
}

function mountPaneHook(
  s: Setup,
  pane: PaneHarness,
): {unmount: () => void} {
  const view = renderHook(() => {
    const scrollerRef = useRef(pane.scroller) as RefObject<HTMLElement | null>
    const result = useTimelineZoom({
      bounds: {start: 0, end: 100},
      labelWidthPx: 0,
      containerWidthPx: 800,
      scrollerRef,
      store: pane.viewportStore,
      selectionStore: pane.view,
      bindingsStore: s.bindings,
      hoveredPaneStore: s.hoveredPaneStore,
      paneId: pane.paneId,
    })
    useEffect(() => {
      result.eventTargetRef(pane.eventSurface)
      return () => {
        result.eventTargetRef(null)
      }
    }, [result])
    return result
  })
  return {unmount: view.unmount}
}

function pressKey(key: string): void {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {key, bubbles: true}),
    )
  })
}

describe('multi-pane keybind hover gating', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('Esc only peels the hovered pane s selection', () => {
    const s = setupTwoPanes()
    // Pane A starts with a committed selection (owns the global store).
    s.paneA.view.setCommitted({startMs: 10, endMs: 30})
    expect(s.global.get().paneId).toBe('pane-A')

    const a = mountPaneHook(s, s.paneA)
    const b = mountPaneHook(s, s.paneB)

    // Cursor is on pane B. Pressing Esc should be a no-op because
    // pane B s filtered view sees no committed selection.
    s.hoveredPaneStore.set('pane-B')
    pressKey('Escape')
    expect(s.global.get().committed).toEqual({startMs: 10, endMs: 30})
    expect(s.global.get().paneId).toBe('pane-A')

    // Move the cursor to pane A. Esc should now peel pane A s
    // selection.
    s.hoveredPaneStore.set('pane-A')
    pressKey('Escape')
    expect(s.global.get().committed).toBeNull()

    a.unmount()
    b.unmount()
  })

  it('Esc on no hovered pane is a complete no-op (cursor over Aggregator)', () => {
    const s = setupTwoPanes()
    s.paneA.view.setCommitted({startMs: 10, endMs: 30})
    s.paneA.view.setSelectedSlice({trackId: 't', startMs: 5, endMs: 9, depth: 0})

    const a = mountPaneHook(s, s.paneA)
    const b = mountPaneHook(s, s.paneB)

    // No pane hovered (cursor sits on the Aggregator or off-page).
    s.hoveredPaneStore.set(null)
    pressKey('Escape')
    pressKey('Escape')
    pressKey('Escape')

    // Pane A s selection survives intact.
    expect(s.global.get().committed).toEqual({startMs: 10, endMs: 30})
    expect(s.global.get().selectedSlice).not.toBeNull()
    expect(s.global.get().paneId).toBe('pane-A')

    a.unmount()
    b.unmount()
  })

  it('a click in pane B clears pane A s selection (single-pane ownership)', () => {
    const s = setupTwoPanes()
    s.paneA.view.setCommitted({startMs: 10, endMs: 30})
    s.paneA.view.setSelectedSlice({trackId: 't', startMs: 5, endMs: 9, depth: 0})
    expect(s.global.get().paneId).toBe('pane-A')

    // Pane B writes a selectedSlice (would be the result of a click).
    s.paneB.view.setSelectedSlice({trackId: 't', startMs: 0, endMs: 4, depth: 0})

    // Pane A s state is now wiped because pane B took ownership.
    expect(s.global.get().paneId).toBe('pane-B')
    expect(s.global.get().selectedSlice).toEqual({
      trackId: 't',
      startMs: 0,
      endMs: 4,
      depth: 0,
    })
    expect(s.global.get().committed).toBeNull()

    // Pane A s filtered view sees nothing.
    expect(s.paneA.view.get().committed).toBeNull()
    expect(s.paneA.view.get().selectedSlice).toBeNull()
    // Pane B s filtered view sees its own slice.
    expect(s.paneB.view.get().selectedSlice).toEqual({
      trackId: 't',
      startMs: 0,
      endMs: 4,
      depth: 0,
    })
  })

  it('hoveredPaneStore.clearIf only clears when the caller still owns hover', () => {
    const s = setupTwoPanes()
    s.hoveredPaneStore.set('pane-A')
    // pane-B s pointerleave fires after the cursor already moved into
    // pane-A. Without the clearIf guard, pane-B s leave handler would
    // null out pane-A s ownership.
    s.hoveredPaneStore.clearIf('pane-B')
    expect(s.hoveredPaneStore.get()).toBe('pane-A')

    // Pane-A s own leave clears as expected.
    s.hoveredPaneStore.clearIf('pane-A')
    expect(s.hoveredPaneStore.get()).toBeNull()
  })
})
