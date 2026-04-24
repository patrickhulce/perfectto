import type {Measure, MeasureAttributionCallsite, Timeline, Track} from '../../core'
import {
  buildAncestorChain,
  findMeasureIndexById,
} from '../../core/render/sliceBuffers'
import type {SliceRef} from './selectionStore'

/**
 * One entry in a reconstructed callstack. A frame wraps the underlying
 * `Measure` for anyone who needs the full record, plus the measure's
 * optional callsite attribution (function name + source location) when
 * the parser produced one.
 *
 * Frames without a callsite attribution are host wrappers (e.g.
 * `FunctionCall`, `v8.callFunction`, tasks, …) that interleave into the
 * ancestor chain; consumers can either render the full chain or filter
 * down to the attributed frames via `attribution.kind === 'callsite'`.
 */
export interface CallstackFrame {
  measure: Measure
  attribution?: MeasureAttributionCallsite
}

export interface ResolvedCallstack {
  /** Track the selected slice lives on, or `null` when the ref didn't resolve. */
  track: Track | null
  /** Full ancestor chain, root → leaf. Empty when the slice didn't resolve. */
  frames: CallstackFrame[]
  /** Index of the selected frame in `frames`, or `-1` if unresolved. */
  leafIndex: number
}

const EMPTY_RESOLVED: ResolvedCallstack = {track: null, frames: [], leafIndex: -1}

/**
 * Find the track and buffer index for a `SliceRef`. Prefers `measureId`
 * (exact, unambiguous) and falls back to a `startMs`/`endMs`/`depth` scan
 * for synthetic refs that predate the id addition.
 */
function locateSlice(
  timeline: Timeline,
  ref: SliceRef,
): {track: Track; index: number} | null {
  for (const system of timeline.systems) {
    for (const track of system.tracks) {
      if (track.id !== ref.trackId) continue
      const buffers = track.buffers
      if (!buffers || buffers.count === 0) return null
      if (ref.measureId !== undefined) {
        const idx = findMeasureIndexById(buffers, ref.measureId)
        if (idx >= 0) return {track, index: idx}
      }
      const {starts, ends, depths, count} = buffers
      for (let i = 0; i < count; i++) {
        if (depths[i] !== ref.depth) continue
        if (starts[i] !== ref.startMs) continue
        if (ends[i] !== ref.endMs) continue
        return {track, index: i}
      }
      return null
    }
  }
  return null
}

function frameFor(measure: Measure): CallstackFrame {
  const attr = measure.attribution
  if (attr && attr.kind === 'callsite') return {measure, attribution: attr}
  return {measure}
}

/**
 * Resolve a `SliceRef` to its ancestor chain (root → leaf).
 *
 * Walks the render-time `SliceBuffers.parentIndex` chain, which is an
 * O(depth) operation and the entire reason that field exists — we avoid
 * storing per-event callstacks while still reconstructing them on demand.
 */
export function resolveCallstack(
  timeline: Timeline,
  ref: SliceRef | null,
): ResolvedCallstack {
  if (!ref) return EMPTY_RESOLVED
  const hit = locateSlice(timeline, ref)
  if (!hit) return EMPTY_RESOLVED
  const buffers = hit.track.buffers
  if (!buffers) return EMPTY_RESOLVED
  const chain = buildAncestorChain(buffers, hit.index)
  if (chain.length === 0) return EMPTY_RESOLVED
  const frames = chain.map(idx => frameFor(buffers.measures[idx]))
  return {track: hit.track, frames, leafIndex: frames.length - 1}
}

/**
 * Predicate for "should the callstack view activate on this selection?".
 * Only when the selected leaf has a `callsite` attribution — that's the
 * parser-provided signal that the measure represents a real frame (as
 * opposed to a host wrapper like `FunctionCall` or `RunTask`).
 */
export function hasCallstackSelection(resolved: ResolvedCallstack): boolean {
  if (resolved.leafIndex < 0) return false
  const leaf = resolved.frames[resolved.leafIndex]
  return leaf?.attribution?.kind === 'callsite'
}
