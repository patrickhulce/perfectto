/**
 * Built-in presets for the input-binding matrix.
 *
 * Each preset is a full {@link BindingSet} keyed on the gesture ids
 * produced by `serializeGesture`. Keyboard shortcuts (W/A/S/D, Z,
 * Escape, arrow keys) are shared across every preset because those
 * weren't part of the user's spec and regressing them would surprise
 * existing users; only the mouse/wheel/drag cells vary.
 *
 * The order here is the order the settings UI displays presets in.
 */

import type {Action, BindingSet, Preset} from './inputBindings'

const SHARED_KEYBOARD: BindingSet = {
  'key:W': 'viewport.nudgeIn',
  'key:S': 'viewport.nudgeOut',
  'key:A': 'viewport.nudgeLeft',
  'key:D': 'viewport.nudgeRight',
  'key:Z': 'selection.zoomToSelection',
  'shift+key:Z': 'selection.clearSelection',
  'key:Escape': 'selection.clearSelection',
}

/** Shared click→deselect semantics. Presets can override to `'none'`. */
const SHARED_CLICK: BindingSet = {
  click: 'selection.deselect',
}

function withShared(mouse: BindingSet): BindingSet {
  return {...SHARED_KEYBOARD, ...SHARED_CLICK, ...mouse}
}

export const PRESET_DEFAULT: Preset = {
  id: 'default',
  name: 'Default',
  builtin: true,
  bindings: withShared({
    // Wheel: pure scroll; modifier zooms. Shift+wheel stays horizontal
    // scroll so macOS trackpad users with physical mice still get the
    // gesture they expect on the mouse side.
    wheel: 'viewport.scrollVertical',
    'shift+wheel': 'viewport.scrollHorizontal',
    'ctrl+wheel': 'viewport.scrollZoom',
    'cmd+wheel': 'viewport.scrollZoom',
    // Drag: left-drag pans horizontally (time-axis only, matches the
    // spatial intuition of "dragging the timeline sideways"), shift+
    // drag selects a range, middle-drag pans both axes.
    leftDrag: 'viewport.panHorizontal',
    'shift+leftDrag': 'selection.selectRange',
    middleDrag: 'viewport.panBoth',
  }),
}

export const PRESET_CHROME_DEVTOOLS: Preset = {
  id: 'chrome-devtools',
  name: 'Chrome DevTools',
  builtin: true,
  bindings: withShared({
    // DevTools Performance panel: wheel zooms, shift+wheel scrolls
    // vertically. Ctrl/Cmd+wheel are intentionally unbound so the
    // browser never intercepts them as page-zoom and the preset has
    // no horizontal-scroll gesture at all (drag instead).
    wheel: 'viewport.scrollZoom',
    'shift+wheel': 'viewport.scrollVertical',
    leftDrag: 'viewport.panBoth',
    'shift+leftDrag': 'selection.selectRange',
    middleDrag: 'viewport.panBoth',
  }),
}

export const PRESET_PERFETTO: Preset = {
  id: 'perfetto',
  name: 'Perfetto',
  builtin: true,
  bindings: withShared({
    // Perfetto: wheel scrolls, ctrl/cmd+wheel zooms, LEFT drag selects,
    // middle drag pans. This matches the app's historical behavior.
    wheel: 'viewport.scrollVertical',
    'shift+wheel': 'viewport.scrollHorizontal',
    'ctrl+wheel': 'viewport.scrollZoom',
    'cmd+wheel': 'viewport.scrollZoom',
    leftDrag: 'selection.selectRange',
    middleDrag: 'viewport.panBoth',
  }),
}

export const PRESET_CHROME_TRACING: Preset = {
  id: 'chrome-tracing',
  name: 'chrome://tracing',
  builtin: true,
  bindings: withShared({
    // chrome://tracing: wheel scrolls vertically, modifiers zoom / pan
    // sideways, drag pans, shift+drag selects.
    wheel: 'viewport.scrollVertical',
    'shift+wheel': 'viewport.scrollHorizontal',
    'ctrl+wheel': 'viewport.scrollZoom',
    'cmd+wheel': 'viewport.scrollZoom',
    leftDrag: 'viewport.panBoth',
    'shift+leftDrag': 'selection.selectRange',
    middleDrag: 'viewport.panBoth',
  }),
}

export const BUILTIN_PRESETS: readonly Preset[] = [
  PRESET_DEFAULT,
  PRESET_CHROME_DEVTOOLS,
  PRESET_PERFETTO,
  PRESET_CHROME_TRACING,
]

export const DEFAULT_PRESET_ID = PRESET_DEFAULT.id

export function findBuiltinPreset(id: string): Preset | undefined {
  return BUILTIN_PRESETS.find(p => p.id === id)
}

/**
 * Shallow equality over binding sets — both halves must have the same
 * keys and each key must map to the same action. Used by the settings
 * UI to decide whether to display the "Modified" badge.
 */
export function bindingsEqual(a: BindingSet, b: BindingSet): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    const av: Action = a[k]
    const bv: Action | undefined = b[k]
    if (bv !== av) return false
  }
  return true
}
