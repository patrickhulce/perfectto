import type {Mark, Measure, TimelineContainer} from '../types'
import {
  DEFAULT_MARK_COLOR,
  DEFAULT_MEASURE_COLOR,
  packColor,
} from './packColor'

/**
 * Flat, struct-of-arrays view of every measure in a track's subtree. Built
 * once at parse finalize; the canvas renderer reads it directly each frame.
 *
 * All arrays are parallel: index `i` refers to the same slice across them.
 * `starts` is sorted ascending (pre-order walk emits ancestors before their
 * children, which preserves start order as long as children are themselves
 * sorted — which `finalizeContainer` guarantees). The canvas culler binary
 * searches on `starts` and iterates forward until the first `starts[i] >
 * visibleEndMs`.
 */
export interface SliceBuffers {
  count: number
  /** Absolute start time in ms (same units as `Timeline.start`). */
  starts: Float32Array
  /** Absolute end time in ms. */
  ends: Float32Array
  /** Nesting depth measured from the track root (0 = direct child of track). */
  depths: Uint16Array
  /** Packed `0xRRGGBBAA` color per slice. */
  colors: Uint32Array
  /** Back-pointer into `measures` for future hit-test / tooltip work. */
  measures: Measure[]
  /**
   * Running maximum of `ends[0..i]`. Non-decreasing (since it's a running
   * max), so the canvas culler can binary-search it for `visibleStartMs`
   * and safely skip every index before the answer — they're all guaranteed
   * to end before the viewport. Without this, a parent slice at index 0
   * with `end = trackDuration` would be culled the moment the viewport
   * scrolls past any of its children's start times.
   */
  maxEndsPrefix: Float32Array
}

/** Same shape as {@link SliceBuffers} but keyed on a single `time` per mark. */
export interface MarkBuffers {
  count: number
  times: Float32Array
  depths: Uint16Array
  colors: Uint32Array
  marks: Mark[]
}

const EMPTY_F32 = new Float32Array(0)
const EMPTY_U16 = new Uint16Array(0)
const EMPTY_U32 = new Uint32Array(0)

export const EMPTY_SLICE_BUFFERS: SliceBuffers = {
  count: 0,
  starts: EMPTY_F32,
  ends: EMPTY_F32,
  depths: EMPTY_U16,
  colors: EMPTY_U32,
  measures: [],
  maxEndsPrefix: EMPTY_F32,
}

export const EMPTY_MARK_BUFFERS: MarkBuffers = {
  count: 0,
  times: EMPTY_F32,
  depths: EMPTY_U16,
  colors: EMPTY_U32,
  marks: [],
}

/**
 * Walk a container's measure subtree in pre-order and collect it into typed
 * arrays. The resulting `starts` array is sorted because the input is sorted
 * by `finalizeContainer` and pre-order visits a parent before its (sorted)
 * children, whose starts are all ≥ parent.start.
 */
export function buildSliceBuffers(root: TimelineContainer): SliceBuffers {
  const total = countMeasures(root)
  if (total === 0) return EMPTY_SLICE_BUFFERS

  const starts = new Float32Array(total)
  const ends = new Float32Array(total)
  const depths = new Uint16Array(total)
  const colors = new Uint32Array(total)
  const measures = new Array<Measure>(total)

  let i = 0
  const visit = (container: TimelineContainer, depth: number): void => {
    for (const m of container.measures) {
      starts[i] = m.start
      ends[i] = m.end
      depths[i] = depth > 0xffff ? 0xffff : depth
      colors[i] = packColor(m.color, DEFAULT_MEASURE_COLOR)
      measures[i] = m
      i += 1
      if (m.measures.length > 0) visit(m, depth + 1)
    }
  }
  visit(root, 0)

  const maxEndsPrefix = new Float32Array(i)
  let running = -Infinity
  for (let k = 0; k < i; k++) {
    const e = ends[k]
    if (e > running) running = e
    maxEndsPrefix[k] = running
  }

  return {count: i, starts, ends, depths, colors, measures, maxEndsPrefix}
}

/**
 * Flatten every mark in a container subtree. Marks live at the depth of
 * whichever measure contains them, so a mark attached to a nested measure
 * still renders at that measure's row.
 */
export function buildMarkBuffers(root: TimelineContainer): MarkBuffers {
  const total = countMarks(root)
  if (total === 0) return EMPTY_MARK_BUFFERS

  const times = new Float32Array(total)
  const depths = new Uint16Array(total)
  const colors = new Uint32Array(total)
  const marks = new Array<Mark>(total)

  let i = 0
  const visit = (container: TimelineContainer, depth: number): void => {
    for (const mk of container.marks) {
      times[i] = mk.time
      depths[i] = depth > 0xffff ? 0xffff : depth
      colors[i] = packColor(mk.color, DEFAULT_MARK_COLOR)
      marks[i] = mk
      i += 1
    }
    for (const m of container.measures) visit(m, depth + 1)
  }
  visit(root, 0)

  // Marks across nested containers aren't guaranteed to be globally sorted —
  // a late mark on a nested measure can appear after all root-level marks.
  // Sort by time so the canvas can binary-search.
  if (!isSortedAscending(times)) sortInPlaceByTime(times, depths, colors, marks)

  return {count: i, times, depths, colors, marks}
}

function countMeasures(root: TimelineContainer): number {
  let n = 0
  const visit = (c: TimelineContainer): void => {
    n += c.measures.length
    for (const m of c.measures) visit(m)
  }
  visit(root)
  return n
}

function countMarks(root: TimelineContainer): number {
  let n = 0
  const visit = (c: TimelineContainer): void => {
    n += c.marks.length
    for (const m of c.measures) visit(m)
  }
  visit(root)
  return n
}

function isSortedAscending(arr: Float32Array): boolean {
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < arr[i - 1]) return false
  }
  return true
}

function sortInPlaceByTime(
  times: Float32Array,
  depths: Uint16Array,
  colors: Uint32Array,
  marks: Mark[],
): void {
  const n = times.length
  const order = new Uint32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  const orderArr = Array.from(order)
  orderArr.sort((a, b) => times[a] - times[b])

  const t2 = new Float32Array(n)
  const d2 = new Uint16Array(n)
  const c2 = new Uint32Array(n)
  const m2 = new Array<Mark>(n)
  for (let i = 0; i < n; i++) {
    const src = orderArr[i]
    t2[i] = times[src]
    d2[i] = depths[src]
    c2[i] = colors[src]
    m2[i] = marks[src]
  }
  times.set(t2)
  depths.set(d2)
  colors.set(c2)
  for (let i = 0; i < n; i++) marks[i] = m2[i]
}

/**
 * Smallest index `i` such that `starts[i] >= target`, or `count` if none.
 * Binary-search lower bound on a Float32Array view.
 */
export function lowerBoundF32(arr: Float32Array, count: number, target: number): number {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Max depth (exclusive upper bound → number of rows) for a SliceBuffers. */
export function maxDepthPlusOne(buffers: SliceBuffers): number {
  let maxD = 0
  for (let i = 0; i < buffers.count; i++) {
    if (buffers.depths[i] > maxD) maxD = buffers.depths[i]
  }
  return buffers.count === 0 ? 0 : maxD + 1
}
