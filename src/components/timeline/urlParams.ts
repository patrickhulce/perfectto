/**
 * URL query-parameter parsing for deep-linking into a trace view.
 *
 * Supports three orthogonal parameter groups:
 *
 *  - `view[startMs]=X&view[endMs]=Y` — zooms the timeline so the range
 *    `[X, Y]` fills the visible content area. Applied once per mount
 *    after the viewport has been measured.
 *  - `selection=<hexId>` — selects the single measure whose parser-
 *    assigned id matches, and sets it as the sticky selected slice.
 *    This is the canonical form; the bracketed `[startMs]`/`[endMs]`
 *    form below predates it and is kept for backward-compat /
 *    hand-edited URLs.
 *  - `selection[startMs]=X&selection[endMs]=Y` — selects the slice
 *    whose bounds match `[X, Y]` and sets it as the sticky selected
 *    slice, which drives the tree-highlight overlay. Optional
 *    `selection[trackId]` and `selection[depth]` disambiguate when
 *    multiple tracks contain a slice with matching bounds.
 *
 * Primarily a debugging affordance: the exact narrow-viewport state
 * can be captured in a single URL like
 * `?view[startMs]=477.5&view[endMs]=479.6&selection=3a7f`.
 */
import type {System, Timeline} from '../../core'
import type {SliceRef} from './selectionStore'

export interface InitialView {
  startMs: number
  endMs: number
}

/**
 * Id-shaped selection request. Produced from the flat `?selection=<id>`
 * form. Resolved against `Measure.id` on any track.
 */
export interface InitialSelectionByIdRequest {
  id: string
}

/**
 * Bounds-shaped selection request. Produced from the bracketed
 * `?selection[startMs]=...&selection[endMs]=...` form. Kept as a
 * backward-compat / hand-edit affordance now that every parsed
 * measure has a stable short id.
 */
export interface InitialSelectionByBoundsRequest {
  startMs: number
  endMs: number
  /**
   * Optional track id. When present we only accept slice matches on
   * that exact track; when absent we scan every track and take the
   * first measure whose bounds match (and whose depth matches, if
   * `depth` is also set).
   */
  trackId?: string
  /** Optional flame-chart depth to disambiguate same-bounded slices. */
  depth?: number
  /**
   * Optional measure name to disambiguate when multiple slices share
   * near-identical bounds across depths (e.g. `FunctionCall` vs
   * `v8.callFunction` wrapping the same mint JS frame). Case-sensitive
   * exact match against `Measure.name`.
   */
  name?: string
}

export type InitialSelectionRequest =
  | InitialSelectionByIdRequest
  | InitialSelectionByBoundsRequest

export interface InitialViewState {
  view: InitialView | null
  selection: InitialSelectionRequest | null
}

/**
 * Tolerance for matching a query-string ms value against a slice's F32
 * `starts[i]` / `ends[i]`. F32 chews up ~6 decimal digits of precision
 * in the hundreds-of-ms range, and URLs are typically hand-typed from
 * rounded values pasted out of bug reports or tooltips. 0.1 ms (100 µs)
 * is loose enough for 3-decimal-digit inputs like `477.9` but tight
 * enough not to cross into unrelated neighbouring slices. Callers can
 * always narrow the match by providing `depth`, `trackId`, or `name`.
 */
const SLICE_MATCH_EPSILON_MS = 0.1

/**
 * Parse `?view[...]&selection[...]` off an already-decoded query string
 * (e.g. `window.location.search`). Returns a fully-null state when no
 * recognised keys are present.
 *
 * Invalid values (non-numeric, or ranges where `startMs >= endMs`) are
 * silently dropped rather than throwing — a bad URL shouldn't prevent
 * the app from loading at all.
 */
export function parseTimelineUrlParams(search: string): InitialViewState {
  const params = new URLSearchParams(search)

  const view = readRange(params, 'view[startMs]', 'view[endMs]')

  let selection: InitialSelectionRequest | null = null

  // Flat id form wins over the bracketed bounds form. Callers should
  // prefer this — the id is stable across re-parses of the same trace
  // and doesn't require hand-copying three numbers.
  const idRaw = params.get('selection')
  if (idRaw !== null && idRaw.length > 0) {
    selection = {id: idRaw}
  } else {
    const selRange = readRange(params, 'selection[startMs]', 'selection[endMs]')
    if (selRange) {
      const trackId = params.get('selection[trackId]') ?? undefined
      const name = params.get('selection[name]') ?? undefined
      const depthRaw = params.get('selection[depth]')
      const depth = depthRaw !== null ? Number(depthRaw) : undefined
      selection = {
        startMs: selRange.startMs,
        endMs: selRange.endMs,
        trackId: trackId || undefined,
        depth: depth !== undefined && Number.isFinite(depth) ? depth : undefined,
        name: name || undefined,
      }
    }
  }

  return {view, selection}
}

function readRange(
  params: URLSearchParams,
  startKey: string,
  endKey: string,
): InitialView | null {
  const startRaw = params.get(startKey)
  const endRaw = params.get(endKey)
  if (startRaw === null || endRaw === null) return null
  const startMs = Number(startRaw)
  const endMs = Number(endRaw)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  if (endMs <= startMs) return null
  return {startMs, endMs}
}

/**
 * Find a slice on one of the timeline's tracks whose `[start, end]`
 * and optional `(trackId, depth)` match the request.
 *
 * Returns `null` when no slice matches — callers should treat that as
 * "don't set an initial selection" rather than throwing. The common
 * reason for a miss is that the trace's F32 precision shifted the
 * authoritative bounds outside `SLICE_MATCH_EPSILON_MS` of whatever
 * value was hardcoded in the URL; widening the tolerance there would
 * cause false positives on very dense traces.
 */
export function resolveInitialSelection(
  timeline: Timeline,
  request: InitialSelectionRequest,
): SliceRef | null {
  const systems: System[] = timeline.systems
  if (isByIdRequest(request)) {
    for (const system of systems) {
      for (const track of system.tracks) {
        const buffers = track.buffers
        if (!buffers || buffers.count === 0) continue
        const {starts, ends, depths, count, measures} = buffers
        for (let i = 0; i < count; i++) {
          if (measures[i]?.id !== request.id) continue
          return {
            trackId: track.id,
            startMs: starts[i],
            endMs: ends[i],
            depth: depths[i],
          }
        }
      }
    }
    return null
  }

  for (const system of systems) {
    for (const track of system.tracks) {
      if (request.trackId && track.id !== request.trackId) continue
      const buffers = track.buffers
      if (!buffers || buffers.count === 0) continue
      const {starts, ends, depths, count} = buffers
      for (let i = 0; i < count; i++) {
        if (Math.abs(starts[i] - request.startMs) > SLICE_MATCH_EPSILON_MS) continue
        if (Math.abs(ends[i] - request.endMs) > SLICE_MATCH_EPSILON_MS) continue
        if (request.depth !== undefined && depths[i] !== request.depth) continue
        if (request.name !== undefined && buffers.measures[i]?.name !== request.name) continue
        return {
          trackId: track.id,
          startMs: starts[i],
          endMs: ends[i],
          depth: depths[i],
        }
      }
    }
  }
  return null
}

function isByIdRequest(
  request: InitialSelectionRequest,
): request is InitialSelectionByIdRequest {
  return typeof (request as InitialSelectionByIdRequest).id === 'string'
}
