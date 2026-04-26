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
  /**
   * Where this compaction came from. Used by UI to tailor labels.
   *
   * - `'sibling'` — adjacent same-(name, category) leaf runs folded by
   *   the finalize-time sibling compactor.
   * - `'cpu-tiny-frames'` — sub-resolution V8 sampler frames folded
   *   under a wider ancestor.
   * - `'subpixel-subtree'` — an entire Measure subtree (any depth) was
   *   replaced by a single representative because the subtree's root
   *   was already too short to render usefully. The fold happens at
   *   the highest possible point so a 0.01 ms span never carries a
   *   128-deep skeleton underneath.
   */
  origin: 'sibling' | 'cpu-tiny-frames' | 'subpixel-subtree'
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
  /**
   * For `'subpixel-subtree'` folds, the deepest descendant level that
   * was collapsed into the representative. Lets the UI surface "≈N
   * frames, up to D levels deep" instead of just a count. Other
   * origins leave this undefined.
   */
  maxDepthFolded?: number
  /**
   * For `'subpixel-subtree'` folds, the number of distinct names in the
   * subtree (not the size of `names`, which we cap at a small preview).
   * Other origins leave this undefined.
   */
  distinctNames?: number
  /**
   * Optional parallel-to-`names` totals: aggregate node duration (ms)
   * for each name in the preview. Lets a blanket-merge of multiple
   * subpixel-subtree folds rank "most prominent inner names" by total
   * time spent rather than by frequency. Same length as `names` when
   * present; absent for origins that don't track this.
   */
  nameDurationsMs?: number[]
  /**
   * For blanket-merged subpixel-subtree folds: how many individual
   * subtree folds were coalesced into this representative. `count`
   * still tells the user "this rect stands in for N source events";
   * `subtreesMerged` answers "...spread across how many independent
   * subtrees". Undefined when this report represents a single fold.
   */
  subtreesMerged?: number
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
  /**
   * Number of subtrees the highest-point cull collapsed into a single
   * synthetic Measure. Zero on traces below the per-track event-count
   * gate (the cull is a no-op on small traces).
   */
  subpixelSubtreesFolded: number
  /**
   * Total descendant Measures (across all depths) absorbed by the
   * subpixel-subtree cull. Excludes the surviving representative.
   */
  subpixelEventsFolded: number
  /**
   * Maximum depth of any single subtree the cull folded. Surfaced in
   * the metadata pane so the user can see e.g. "1425-deep recursion
   * collapsed" without having to scan compaction reports manually.
   */
  subpixelMaxDepthFolded: number
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
  /**
   * Optional human-readable status line for the current phase. Parsers
   * use this to surface sub-phase progress that wouldn't otherwise
   * show up in `bytesRead` — e.g. "Finalizing Renderer (track 4/12)"
   * during finalize, where we're walking a per-process tree rather
   * than reading bytes. The viewer renders it under the phase label;
   * absent / empty means no sub-status to show.
   */
  detail?: string
  /**
   * Optional event-count progress for the finalize phase. The parser
   * pumps this every ~50ms (same throttle as the byte counter) so the
   * UI can show real motion while it walks per-track buffers, instead
   * of the bar sitting at 100% during a 20-second finalize. `total` is
   * the parser's best estimate of the work to do across all stages
   * (cull + compact + fixup); `processed` is monotonic and saturates
   * at `total` when finalize completes.
   */
  events?: {
    processed: number
    total: number
  }
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
  /**
   * Soft cap on bytes consumed from the input stream(s) before parsing
   * stops and finalize runs over whatever's been collected so far. Use
   * this as a safety valve against a runaway file (e.g. a 50 GB Chrome
   * trace dropped by mistake) to keep the worker from slowly OOM'ing
   * the tab. Once exceeded we cancel the underlying reader and emit a
   * final `'parsing'` progress event with `detail: 'truncated'`.
   *
   * Counted in *decompressed* bytes for gzipped inputs (the same units
   * as `ParseProgress.bytesRead`). Undefined / non-finite / ≤ 0 means
   * unlimited (the default — small traces shouldn't pay any cost for
   * this guard).
   */
  maxBytes?: number
}
