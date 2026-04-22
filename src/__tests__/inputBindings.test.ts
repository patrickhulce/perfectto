import {
  formatGestureLabel,
  matchGesture,
  modsFromEvent,
  normalizeKey,
  parseGestureId,
  serializeGesture,
  sortMods,
  type BindingSet,
} from '../components/timeline/inputBindings'
import {
  BUILTIN_PRESETS,
  PRESET_DEFAULT,
  PRESET_PERFETTO,
  bindingsEqual,
  findBuiltinPreset,
} from '../components/timeline/inputPresets'
import {
  __test__ as storeTest,
  createInputBindingsStore,
} from '../components/timeline/inputBindingsStore'
import {
  classifyWheel,
  __test__ as trackpadTest,
} from '../components/timeline/trackpadDetect'

describe('serializeGesture / parseGestureId', () => {
  test('round-trips canonical mod ordering regardless of input order', () => {
    expect(serializeGesture({kind: 'wheel', mods: ['shift', 'ctrl']})).toBe(
      'ctrl+shift+wheel',
    )
    expect(serializeGesture({kind: 'wheel', mods: ['ctrl', 'shift']})).toBe(
      'ctrl+shift+wheel',
    )
  })

  test('serializes key gestures with the upper-case key', () => {
    expect(serializeGesture({kind: 'key', mods: [], key: 'w'})).toBe('key:W')
    expect(serializeGesture({kind: 'key', mods: ['shift'], key: 'z'})).toBe(
      'shift+key:Z',
    )
    expect(serializeGesture({kind: 'key', mods: [], key: 'Escape'})).toBe(
      'key:Escape',
    )
  })

  test('parses canonical ids back into Gesture objects', () => {
    const g = parseGestureId('shift+ctrl+leftDrag')
    expect(g).not.toBeNull()
    expect(g?.kind).toBe('leftDrag')
    expect(g?.mods).toEqual(['ctrl', 'shift'])

    const k = parseGestureId('shift+key:Z')
    expect(k?.kind).toBe('key')
    expect(k?.key).toBe('Z')
    expect(k?.mods).toEqual(['shift'])
  })

  test('returns null on garbage', () => {
    expect(parseGestureId('totally-bogus')).toBeNull()
    expect(parseGestureId('')).toBeNull()
  })
})

describe('sortMods / modsFromEvent', () => {
  test('sortMods deduplicates and uses canonical order', () => {
    expect(sortMods(['shift', 'shift', 'ctrl', 'opt'])).toEqual([
      'ctrl',
      'opt',
      'shift',
    ])
  })

  test('modsFromEvent maps the four boolean flags', () => {
    expect(
      modsFromEvent({shiftKey: true, ctrlKey: false, metaKey: true, altKey: false}),
    ).toEqual(['cmd', 'shift'])
    expect(modsFromEvent({})).toEqual([])
  })
})

describe('normalizeKey', () => {
  test('upper-cases single letters but passes named keys through', () => {
    expect(normalizeKey('w')).toBe('W')
    expect(normalizeKey('Z')).toBe('Z')
    expect(normalizeKey('Escape')).toBe('Escape')
    expect(normalizeKey('ArrowLeft')).toBe('ArrowLeft')
  })
})

describe('matchGesture', () => {
  const bindings: BindingSet = {
    wheel: 'viewport.scrollVertical',
    'shift+wheel': 'viewport.scrollHorizontal',
    'ctrl+wheel': 'viewport.scrollZoom',
    'key:W': 'viewport.nudgeIn',
  }

  test('returns the bound action when the (kind, mods) tuple matches', () => {
    expect(matchGesture('wheel', [], bindings)).toBe('viewport.scrollVertical')
    expect(matchGesture('wheel', ['shift'], bindings)).toBe(
      'viewport.scrollHorizontal',
    )
    expect(matchGesture('wheel', ['ctrl'], bindings)).toBe('viewport.scrollZoom')
  })

  test('treats cmd and ctrl as distinct', () => {
    expect(matchGesture('wheel', ['cmd'], bindings)).toBe('none')
  })

  test('mod ordering does not affect lookup', () => {
    const local: BindingSet = {'ctrl+shift+wheel': 'viewport.scrollZoom'}
    expect(matchGesture('wheel', ['shift', 'ctrl'], local)).toBe(
      'viewport.scrollZoom',
    )
  })

  test('returns "none" for unbound gestures', () => {
    expect(matchGesture('middleDrag', [], bindings)).toBe('none')
  })

  test('matches keyboard gestures by normalized key', () => {
    expect(matchGesture('key', [], bindings, 'w')).toBe('viewport.nudgeIn')
    expect(matchGesture('key', [], bindings, 'W')).toBe('viewport.nudgeIn')
  })
})

describe('formatGestureLabel', () => {
  test('renders a friendly label with mods on the left', () => {
    expect(formatGestureLabel('wheel')).toBe('Wheel')
    expect(formatGestureLabel('shift+wheel')).toBe('Shift + Wheel')
    expect(formatGestureLabel('ctrl+leftDrag')).toBe('Ctrl + Left drag')
    expect(formatGestureLabel('middleDrag')).toBe('Middle drag')
    expect(formatGestureLabel('shift+key:Z')).toBe('Shift + Key: Z')
  })
})

describe('built-in presets', () => {
  test('every preset binds the standard keyboard shortcuts', () => {
    for (const p of BUILTIN_PRESETS) {
      expect(p.bindings['key:W']).toBe('viewport.nudgeIn')
      expect(p.bindings['key:S']).toBe('viewport.nudgeOut')
      expect(p.bindings['key:A']).toBe('viewport.nudgeLeft')
      expect(p.bindings['key:D']).toBe('viewport.nudgeRight')
      expect(p.bindings['key:Escape']).toBe('selection.clearSelection')
      expect(p.bindings['key:Z']).toBe('selection.zoomToSelection')
    }
  })

  test('Default preset uses pan-on-drag with shift+drag selecting', () => {
    expect(PRESET_DEFAULT.bindings['leftDrag']).toBe('viewport.panHorizontal')
    expect(PRESET_DEFAULT.bindings['shift+leftDrag']).toBe(
      'selection.selectRange',
    )
  })

  test('Perfetto preset preserves left-drag-to-select for users who prefer it', () => {
    expect(PRESET_PERFETTO.bindings['leftDrag']).toBe('selection.selectRange')
    expect(PRESET_PERFETTO.bindings['middleDrag']).toBe('viewport.panBoth')
  })

  test('bindingsEqual compares exact binding sets', () => {
    const a = {wheel: 'viewport.scrollZoom' as const}
    const b = {wheel: 'viewport.scrollZoom' as const}
    const c = {wheel: 'viewport.scrollVertical' as const}
    expect(bindingsEqual(a, b)).toBe(true)
    expect(bindingsEqual(a, c)).toBe(false)
    expect(bindingsEqual(a, {})).toBe(false)
  })

  test('findBuiltinPreset looks up by id', () => {
    expect(findBuiltinPreset('default')?.id).toBe('default')
    expect(findBuiltinPreset('chrome-devtools')?.id).toBe('chrome-devtools')
    expect(findBuiltinPreset('does-not-exist')).toBeUndefined()
  })
})

describe('InputBindingsStore', () => {
  function makeMemoryStorage(): Storage {
    const data = new Map<string, string>()
    return {
      get length(): number {
        return data.size
      },
      clear: () => data.clear(),
      getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
      setItem: (k: string, v: string) => {
        data.set(k, v)
      },
      removeItem: (k: string) => {
        data.delete(k)
      },
      key: (i: number) => Array.from(data.keys())[i] ?? null,
    }
  }

  test('seeds from the Default preset when no persisted state exists', () => {
    const storage = makeMemoryStorage()
    const store = createInputBindingsStore(storage)
    expect(store.get().activePresetId).toBe('default')
    expect(store.get().bindings['leftDrag']).toBe('viewport.panHorizontal')
  })

  test('applyPreset switches active preset and copies its bindings', () => {
    const storage = makeMemoryStorage()
    const store = createInputBindingsStore(storage)
    store.applyPreset('perfetto')
    expect(store.get().activePresetId).toBe('perfetto')
    expect(store.get().bindings['leftDrag']).toBe('selection.selectRange')
  })

  test('updateBinding mutates one cell and isModified reports the divergence', () => {
    const storage = makeMemoryStorage()
    const store = createInputBindingsStore(storage)
    expect(store.isModified()).toBe(false)
    store.updateBinding('wheel', 'viewport.scrollZoom')
    expect(store.get().bindings['wheel']).toBe('viewport.scrollZoom')
    expect(store.isModified()).toBe(true)
  })

  test('updateBinding with "none" deletes the cell', () => {
    const storage = makeMemoryStorage()
    const store = createInputBindingsStore(storage)
    expect(store.get().bindings['wheel']).toBe('viewport.scrollVertical')
    store.updateBinding('wheel', 'none')
    expect('wheel' in store.get().bindings).toBe(false)
  })

  test('saveAsPreset clones live bindings into a new custom preset', () => {
    const storage = makeMemoryStorage()
    const store = createInputBindingsStore(storage)
    store.updateBinding('shift+wheel', 'viewport.scrollZoom')
    const id = store.saveAsPreset('My Preset')
    expect(id.startsWith('custom-')).toBe(true)
    const preset = store.findPreset(id)
    expect(preset?.builtin).toBe(false)
    expect(preset?.name).toBe('My Preset')
    expect(preset?.bindings['shift+wheel']).toBe('viewport.scrollZoom')
    expect(store.get().activePresetId).toBe(id)
  })

  test('deletePreset removes a custom preset and falls back to Default', () => {
    const storage = makeMemoryStorage()
    const store = createInputBindingsStore(storage)
    const id = store.saveAsPreset('Tmp')
    expect(store.get().activePresetId).toBe(id)
    store.deletePreset(id)
    expect(store.findPreset(id)).toBeUndefined()
    expect(store.get().activePresetId).toBe('default')
  })

  test('reset always returns to the Default preset', () => {
    const storage = makeMemoryStorage()
    const store = createInputBindingsStore(storage)
    store.applyPreset('chrome-devtools')
    store.updateBinding('wheel', 'viewport.scrollVertical')
    store.reset()
    expect(store.get().activePresetId).toBe('default')
    expect(store.isModified()).toBe(false)
  })

  test('changes are persisted to storage and rehydrated on reload', () => {
    const storage = makeMemoryStorage()
    const store = createInputBindingsStore(storage)
    store.applyPreset('perfetto')
    store.updateBinding('shift+wheel', 'viewport.scrollZoom')

    const persisted = storage.getItem(storeTest.STORAGE_KEY)
    expect(persisted).not.toBeNull()

    const reloaded = createInputBindingsStore(storage)
    expect(reloaded.get().activePresetId).toBe('perfetto')
    expect(reloaded.get().bindings['shift+wheel']).toBe('viewport.scrollZoom')
  })

  test('subscribers fire on every change with the new state', () => {
    const storage = makeMemoryStorage()
    const store = createInputBindingsStore(storage)
    const events: string[] = []
    const unsub = store.subscribe(s => events.push(s.activePresetId))
    store.applyPreset('perfetto')
    store.applyPreset('chrome-devtools')
    unsub()
    store.applyPreset('default')
    expect(events).toEqual(['perfetto', 'chrome-devtools'])
  })
})

describe('classifyWheel', () => {
  function makeWheel(props: Partial<WheelEvent>): WheelEvent {
    return {
      deltaMode: 0,
      deltaX: 0,
      deltaY: 0,
      ctrlKey: false,
      ...props,
    } as WheelEvent
  }

  test('detects synthetic-ctrl pinch (Ctrl key not actually held)', () => {
    expect(classifyWheel(makeWheel({ctrlKey: true, deltaY: -3}), false)).toBe(
      'trackpad-pinch',
    )
  })

  test('treats real Ctrl + wheel as a mouse-wheel gesture', () => {
    // Ctrl is physically down, wheel delta is mouse-wheel-ish
    expect(classifyWheel(makeWheel({ctrlKey: true, deltaY: 100}), true)).toBe(
      'mouse-wheel',
    )
  })

  test('large integer deltaY is mouse-wheel', () => {
    expect(classifyWheel(makeWheel({deltaY: 100}), false)).toBe('mouse-wheel')
    expect(classifyWheel(makeWheel({deltaY: -120}), false)).toBe('mouse-wheel')
  })

  test('small pixel deltas are trackpad scroll', () => {
    expect(
      classifyWheel(makeWheel({deltaY: 12}), false),
    ).toBe('trackpad-scroll')
  })

  test('diagonal pixel deltas are trackpad scroll', () => {
    expect(
      classifyWheel(makeWheel({deltaX: 80, deltaY: 80}), false),
    ).toBe('trackpad-scroll')
  })

  test('non-integer deltas are trackpad', () => {
    expect(classifyWheel(makeWheel({deltaY: 1.5}), false)).toBe(
      'trackpad-scroll',
    )
  })

  test('non-pixel deltaMode is mouse-wheel regardless of magnitude', () => {
    expect(classifyWheel(makeWheel({deltaY: 1, deltaMode: 1}), false)).toBe(
      'mouse-wheel',
    )
  })

  test('threshold matches the documented value', () => {
    expect(trackpadTest.TRACKPAD_DELTA_THRESHOLD).toBe(50)
  })

  test('Cmd + small-delta wheel is mouse-wheel (macOS smooth-scroll momentum)', () => {
    // macOS Chrome decomposes a single physical wheel notch under
    // cmd+wheel into a leading large event plus several small
    // momentum/smoothing events. The small ones must still route
    // through the binding matrix so the user sees continuous zoom
    // across the flick instead of a single step.
    expect(
      classifyWheel(makeWheel({metaKey: true, deltaY: 12}), false),
    ).toBe('mouse-wheel')
    expect(
      classifyWheel(makeWheel({metaKey: true, deltaY: 3.5}), false),
    ).toBe('mouse-wheel')
  })

  test('real Ctrl + small-delta wheel is mouse-wheel (same smooth-scroll case)', () => {
    expect(
      classifyWheel(makeWheel({ctrlKey: true, deltaY: 12}), true),
    ).toBe('mouse-wheel')
  })
})
