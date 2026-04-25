export type RawEvent = Record<string, unknown>

export interface TimelineContainer {
  marks: Mark[]
  measures: Measure[]
  /**
   * Maximum `end` time found anywhere in this container's subtree. Populated by
   * parsers so the viewer can cheaply prune entire subtrees that fall outside
   * the visible viewport. Optional for parsers that don't set it.
   */
  maxEnd?: number
}

export interface Mark {
  id: string
  name: string
  time: number
  category?: string
  color?: string
  events: RawEvent[]
}

export interface SourceLocation {
  url?: string
  lineNumber?: number
  columnNumber?: number
}

/**
 * A measure that represents a single frame in a call stack (JS, native,
 * etc.). Carries everything the UI needs to render a stack entry without
 * reaching back into parser-internal raw events or category strings.
 */
export interface MeasureAttributionCallsite {
  kind: 'callsite'
  /** Display label for the frame (e.g. function name, or '(anonymous)'). */
  label: string
  /** Optional source location for the call site. */
  location?: SourceLocation
  /**
   * Where this attribution came from. Lets future UIs filter/group by
   * producer (e.g. 'v8-cpu-profile') without re-coupling to internals.
   */
  source?: string
}

/**
 * Display-ready metadata a parser attaches to a {@link Measure} to tell
 * the UI what the measure represents. Discriminated by `kind` so future
 * producers can add new attribution shapes without reshuffling.
 */
export type MeasureAttribution = MeasureAttributionCallsite

export interface Measure extends TimelineContainer {
  id: string
  name: string
  start: number
  end: number
  category?: string
  color?: string
  events: RawEvent[]
  compaction?: CompactionReport[]
  /**
   * Optional display-ready metadata describing *what this measure
   * represents* in a way the UI can act on generically (e.g. render a
   * callstack, surface a code location). Parsers populate this; UI code
   * must not inspect raw events or categories to reconstruct the same
   * information.
   */
  attribution?: MeasureAttribution
}

/**
 * Summary of a run of events that were folded into a single Measure by
 * the compactor. Intentionally carries only aggregate statistics — never
 * the raw event objects — so a single compacted Measure costs O(1) RAM
 * regardless of how many events it represents.
 *
 * Producers populate this in two places:
 *
 *   - The finalize-time sibling compactor collapses runs of adjacent
 *     same-(category, name) siblings whose aggregate span stays under a
 *     threshold. `origin = 'sibling'` and `names` carries the single
 *     shared name (kept as a list for forward-compatibility with future
 *     multi-name variants).
 *   - The CPU-profile tiny-frame compactor collapses sub-resolution
 *     child frames under a wider ancestor. `origin = 'cpu-tiny-frames'`
 *     and `names` lists the distinct frame labels that were folded.
 *
 * UI code should surface `count` prominently (it's what tells the user
 * "this rect represents N events, not one") and may show a condensed
 * `names` preview in a tooltip.
 */
export interface CompactionReport {
  /** Where this compaction came from. Used by UI to tailor labels. */
  origin: 'sibling' | 'cpu-tiny-frames'
  /** Category shared by every folded event (or the representative's category). */
  category?: string
  /** Names that appeared in the run — deduped, sorted for display stability. */
  names: string[]
  /** Total number of source events that were folded into the Measure. */
  count: number
  /** Earliest `ts` across the folded run, in ms. */
  firstTs: number
  /** Latest `end` across the folded run, in ms. */
  lastTs: number
  /**
   * Aggregate "on" time across the run — sum of durations — in ms. Useful
   * for the UI to show "N events · Mms wall time" without re-scanning.
   */
  totalDurationMs: number
}

/**
 * Parser-level counters recorded during compaction. Attached to
 * {@link TraceMetadata.compaction} so the SettingsPanel / Metadata bar
 * can surface a read-only "large-trace" summary without the UI having
 * to walk the timeline itself.
 */
export interface CompactionMetadata {
  /** Events folded by the online streaming compactor (per-thread run-merging). */
  onlineEventsFolded: number
  /** True iff the online compactor crossed its trigger threshold at least once. */
  onlineTriggered: boolean
  /** Runs of same-name siblings collapsed at finalize. */
  siblingRunsFolded: number
  /** Total source events folded by the finalize sibling compactor. */
  siblingEventsFolded: number
  /** Count of CPU-profile tiny-frame compactions emitted at finalize. */
  cpuTinyRunsFolded: number
  /** Total source CPU-profile frames folded into tiny-frame compactions. */
  cpuTinyEventsFolded: number
}

export interface Track extends TimelineContainer {
  id: string
  name: string
  category?: string
  /**
   * Optional flat struct-of-arrays view of the track's entire subtree, built
   * by the parser at finalize time. The canvas renderer consumes this
   * directly — it's O(1) to hand to the GPU and amortizes all per-measure
   * work (color packing, depth, sort) onto the parse phase.
   */
  buffers?: import('./render/sliceBuffers').SliceBuffers
  /** Matching flat view for the track's marks. */
  markBuffers?: import('./render/sliceBuffers').MarkBuffers
  /**
   * Resolution-aware LOD pyramid built on top of {@link buffers} at parse
   * finalize. The canvas renderer picks the coarsest level whose resolution
   * still fits one pixel at the current zoom, rendering density-tinted
   * buckets instead of tens of thousands of sub-pixel rects.
   */
  mipmap?: import('./render/sliceBuffers').SliceMipmap
}

export interface System {
  id: string
  name: string
  tracks: Track[]
}

export interface Timeline {
  start: number
  end: number
  systems: System[]
}

export interface TraceMetadata {
  /**
   * Optional compaction summary populated by the parser. Absent on tiny
   * traces where compaction never fired; always present when any
   * non-zero counter could be reported.
   */
  compaction?: CompactionMetadata
  [key: string]: unknown
}

export interface TraceSource {
  name: string
  size: number
}

export interface ParsedTrace {
  source: TraceSource
  metadata: TraceMetadata
  timeline: Timeline
}

/**
 * Lazy walker yielding every Mark and Measure in the timeline. The
 * parser used to eagerly materialize this as `ParsedTrace.events` but
 * the resulting array doubled the reference footprint at finalize for
 * no reader — nothing in the UI consumes it. Callers that still need a
 * flat iteration (tests, debug tooling) can drive this generator.
 */
export function* iterateTimelineEvents(timeline: Timeline): Generator<Mark | Measure, void, void> {
  for (const system of timeline.systems) {
    for (const track of system.tracks) {
      yield* iterateContainer(track)
    }
  }
}

function* iterateContainer(container: TimelineContainer): Generator<Mark | Measure, void, void> {
  for (const mark of container.marks) yield mark
  for (const measure of container.measures) {
    yield measure
    yield* iterateContainer(measure)
  }
}

export type TraceInput =
  | ReadableStream<Uint8Array>
  | AsyncIterable<ReadableStream<Uint8Array>>

export interface ParseProgress {
  streamIndex: number
  bytesRead: number
  phase: 'parsing' | 'finalizing' | 'done'
}

export interface ParseOptions {
  signal?: AbortSignal
  onProgress?: (progress: ParseProgress) => void
  /**
   * Chrome-parser knobs. Only consulted when the detected parser is the
   * Chrome trace parser; other parsers ignore them. Defaults match what
   * DevTools shows out of the box.
   */
  chromeParser?: import('./parsers/chrome/chrome-types').ChromeParserOptions
}
