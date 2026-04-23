import type {Measure, RawEvent, Timeline, Track} from '../../core'
import {
  buildAncestorChain,
  findMeasureIndexById,
} from '../../core/render/sliceBuffers'
import type {SliceRef} from './selectionStore'

/** The parser-assigned category for V8 CPU-profiler frames. */
export const JS_FRAME_CATEGORY = 'jsFrame'
/** `ph` of the synthetic raw event that carries JS frame metadata. */
export const JS_FRAME_PHASE = 'JS_FRAME'

/**
 * One entry in a reconstructed callstack. A frame wraps the underlying
 * `Measure` for anyone who needs the full record, plus the commonly-shown
 * call-site fields pulled from the synthetic `JS_FRAME` raw event.
 *
 * `isJsFrame` distinguishes true V8 sample frames from host measures
 * (`FunctionCall`, `v8.callFunction`, …) that get interleaved into the
 * ancestor chain; consumers can either render the full chain or filter
 * down to the JS frames.
 */
export interface CallstackFrame {
  measure: Measure
  isJsFrame: boolean
  functionName?: string
  url?: string
  lineNumber?: number
  columnNumber?: number
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

function findJsFrameEvent(measure: Measure): RawEvent | undefined {
  for (const ev of measure.events) {
    if ((ev as {ph?: unknown}).ph === JS_FRAME_PHASE) return ev
  }
  return undefined
}

function frameFor(measure: Measure): CallstackFrame {
  const isJsFrame = measure.category === JS_FRAME_CATEGORY
  if (!isJsFrame) return {measure, isJsFrame}
  const ev = findJsFrameEvent(measure)
  if (!ev) return {measure, isJsFrame}
  const functionName = typeof ev.functionName === 'string' ? ev.functionName : undefined
  const url = typeof ev.url === 'string' ? ev.url : undefined
  const lineNumber = typeof ev.lineNumber === 'number' ? ev.lineNumber : undefined
  const columnNumber = typeof ev.columnNumber === 'number' ? ev.columnNumber : undefined
  return {measure, isJsFrame, functionName, url, lineNumber, columnNumber}
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
 * Matches the plan: only when the selected slice is itself a JS frame,
 * to keep the panel focused and avoid surfacing host-measure ancestry
 * as a pseudo-callstack for non-JS selections.
 */
export function isJsFrameSelection(resolved: ResolvedCallstack): boolean {
  if (resolved.leafIndex < 0) return false
  const leaf = resolved.frames[resolved.leafIndex]
  return leaf?.isJsFrame === true
}
