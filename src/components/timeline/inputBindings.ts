/**
 * Input-binding vocabulary for the timeline viewport.
 *
 * The timeline's wheel / pointer / keyboard handlers used to hardcode
 * the mapping from gesture → action (ctrl+wheel always zoomed, left
 * drag always selected, etc.). This module externalises the mapping so
 * the user can pick a preset (Chrome DevTools / Perfetto / chrome://
 * tracing / …) or rebind any single gesture from the settings panel.
 *
 * Shape:
 *  - {@link Action} is the closed set of things the timeline can do
 *    (zoom, pan, select, etc.). Hooks dispatch on these names.
 *  - {@link Gesture} is the closed set of input gestures the user can
 *    express (wheel + modifiers, drag + modifiers, click, key press).
 *    The settings UI presents rows from this set.
 *  - {@link BindingSet} is just a `Record<gestureId, Action>`. Gestures
 *    are serialised to stable string ids so they can be JSON-persisted.
 *
 * Trackpad two-finger scroll and pinch are **not** represented here —
 * those bypass the binding matrix entirely (see `useTimelineViewport`).
 */

/** Things the timeline can do in response to an input gesture. */
export type Action =
  | 'viewport.scrollHorizontal'
  | 'viewport.scrollVertical'
  | 'viewport.scrollZoom'
  | 'viewport.panHorizontal'
  | 'viewport.panVertical'
  | 'viewport.panBoth'
  | 'viewport.nudgeLeft'
  | 'viewport.nudgeRight'
  | 'viewport.nudgeIn'
  | 'viewport.nudgeOut'
  | 'selection.selectRange'
  | 'selection.deselect'
  | 'selection.zoomToSelection'
  | 'selection.clearSelection'
  | 'none'

export const ALL_ACTIONS: readonly Action[] = [
  'none',
  'viewport.scrollHorizontal',
  'viewport.scrollVertical',
  'viewport.scrollZoom',
  'viewport.panHorizontal',
  'viewport.panVertical',
  'viewport.panBoth',
  'viewport.nudgeLeft',
  'viewport.nudgeRight',
  'viewport.nudgeIn',
  'viewport.nudgeOut',
  'selection.selectRange',
  'selection.deselect',
  'selection.zoomToSelection',
  'selection.clearSelection',
]

/** Human-readable labels for the settings UI. */
export const ACTION_LABELS: Record<Action, string> = {
  none: '— none —',
  'viewport.scrollHorizontal': 'Scroll horizontally',
  'viewport.scrollVertical': 'Scroll vertically',
  'viewport.scrollZoom': 'Zoom',
  'viewport.panHorizontal': 'Pan horizontally',
  'viewport.panVertical': 'Pan vertically',
  'viewport.panBoth': 'Pan (both axes)',
  'viewport.nudgeLeft': 'Nudge left',
  'viewport.nudgeRight': 'Nudge right',
  'viewport.nudgeIn': 'Nudge in (zoom step)',
  'viewport.nudgeOut': 'Nudge out (zoom step)',
  'selection.selectRange': 'Select range',
  'selection.deselect': 'Deselect (click away)',
  'selection.zoomToSelection': 'Zoom to selection',
  'selection.clearSelection': 'Clear selection',
}

/**
 * Modifier keys. `cmd` is `metaKey` (⌘ on mac, Win on Windows), kept
 * distinct from `ctrl` so cross-platform bindings can target either.
 */
export type Modifier = 'shift' | 'cmd' | 'opt' | 'ctrl'

/** Canonical ordering so `[shift, ctrl]` and `[ctrl, shift]` serialise identically. */
const MOD_ORDER: readonly Modifier[] = ['ctrl', 'cmd', 'opt', 'shift']

export function sortMods(mods: readonly Modifier[]): Modifier[] {
  const seen = new Set<Modifier>()
  const out: Modifier[] = []
  for (const m of MOD_ORDER) {
    if (mods.includes(m) && !seen.has(m)) {
      out.push(m)
      seen.add(m)
    }
  }
  return out
}

/** The five input kinds the matrix can bind. */
export type GestureKind = 'wheel' | 'leftDrag' | 'middleDrag' | 'click' | 'key'

export interface Gesture {
  kind: GestureKind
  /** Sorted canonically via {@link sortMods}. */
  mods: Modifier[]
  /** Only meaningful for `kind === 'key'`. The `KeyboardEvent.key` value. */
  key?: string
}

/** Map of serialised gesture id → bound action. */
export type BindingSet = Record<string, Action>

export interface Preset {
  id: string
  name: string
  /** Built-in presets are read-only; users can clone them via "Save as". */
  builtin: boolean
  bindings: BindingSet
}

const MOD_SEP = '+'

/**
 * Stable, human-readable gesture id. Examples:
 *  - `wheel`
 *  - `shift+wheel`
 *  - `ctrl+cmd+wheel`
 *  - `leftDrag`
 *  - `shift+leftDrag`
 *  - `middleDrag`
 *  - `click`
 *  - `key:W`
 *  - `shift+key:Z`
 *  - `key:Escape`
 *
 * Mods always precede the kind (and key, if any). Normalises letter
 * keys to upper-case so `W` and `w` are the same binding.
 */
export function serializeGesture(g: Gesture): string {
  const mods = sortMods(g.mods)
  const kindPart = g.kind === 'key' ? `key:${normalizeKey(g.key ?? '')}` : g.kind
  if (mods.length === 0) return kindPart
  return [...mods, kindPart].join(MOD_SEP)
}

export function parseGestureId(id: string): Gesture | null {
  const parts = id.split(MOD_SEP)
  if (parts.length === 0) return null
  const mods: Modifier[] = []
  let kindPart: string | null = null
  for (const p of parts) {
    if (p === 'shift' || p === 'cmd' || p === 'opt' || p === 'ctrl') {
      mods.push(p)
    } else {
      kindPart = p
    }
  }
  if (kindPart === null) return null
  if (kindPart.startsWith('key:')) {
    return {kind: 'key', mods: sortMods(mods), key: kindPart.slice('key:'.length)}
  }
  if (
    kindPart === 'wheel' ||
    kindPart === 'leftDrag' ||
    kindPart === 'middleDrag' ||
    kindPart === 'click'
  ) {
    return {kind: kindPart, mods: sortMods(mods)}
  }
  return null
}

/**
 * Normalise a `KeyboardEvent.key` string to the form we store in gesture
 * ids. Letter keys become their upper-case form so a binding to `W`
 * matches both `w` and `W` (the settings UI only renders letters in
 * upper case). Named keys like `Escape`, `ArrowLeft` pass through.
 */
export function normalizeKey(key: string): string {
  if (key.length === 1) return key.toUpperCase()
  return key
}

/** Extract the set of modifiers active on a given event. */
export function modsFromEvent(e: {
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}): Modifier[] {
  const mods: Modifier[] = []
  if (e.ctrlKey) mods.push('ctrl')
  if (e.metaKey) mods.push('cmd')
  if (e.altKey) mods.push('opt')
  if (e.shiftKey) mods.push('shift')
  return sortMods(mods)
}

/**
 * Look up the action bound to a given (kind, mods[, key]) tuple in
 * `bindings`. Returns `'none'` when there is no binding (or it's
 * explicitly bound to `none`).
 *
 * `cmd` and `ctrl` are treated as distinct. Callers that want
 * cross-platform bindings (e.g. "ctrl or cmd + wheel zooms") are
 * expected to populate both ids in their preset.
 */
export function matchGesture(
  kind: GestureKind,
  mods: readonly Modifier[],
  bindings: BindingSet,
  key?: string,
): Action {
  const id = serializeGesture({kind, mods: sortMods(mods), key})
  return bindings[id] ?? 'none'
}

/**
 * Pretty-print a gesture id for the settings UI. Keeps the ordering of
 * modifiers stable.
 */
export function formatGestureLabel(id: string): string {
  const g = parseGestureId(id)
  if (!g) return id
  const modLabels = g.mods.map(modLabel)
  let tail: string
  switch (g.kind) {
    case 'wheel':
      tail = 'Wheel'
      break
    case 'leftDrag':
      tail = 'Left drag'
      break
    case 'middleDrag':
      tail = 'Middle drag'
      break
    case 'click':
      tail = 'Click'
      break
    case 'key':
      tail = `Key: ${g.key ?? ''}`
      break
  }
  if (modLabels.length === 0) return tail
  return `${modLabels.join(' + ')} + ${tail}`
}

function modLabel(m: Modifier): string {
  switch (m) {
    case 'shift':
      return 'Shift'
    case 'cmd':
      return 'Cmd'
    case 'opt':
      return 'Opt'
    case 'ctrl':
      return 'Ctrl'
  }
}
