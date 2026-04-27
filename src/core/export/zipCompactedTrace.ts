/**
 * Compacted-trace export.
 *
 * Walks an in-memory {@link ParsedTrace} and emits a gzipped Chrome Trace
 * Event Format JSON that, when fed back through {@link import('../parser').parseTrace},
 * reconstructs an equivalent visualization. The export is **intentionally
 * lossy** — per-event `args`, V8 `ProfileChunk` samples, async / counter /
 * flow events, and original `pid`/`tid` identities are dropped. What
 * survives is what the visualization actually consumes:
 *
 *   - System / Track hierarchy (names + sort order).
 *   - Measure tree (start, end, name, category, color, attribution).
 *   - {@link CompactionReport}s, lifted across the boundary via
 *     `args._pfctoCompaction` so re-import shows the same "folded N" pills.
 *   - Marks (as `i` instant events).
 *   - The trace's existing `metadata` (the chrome parser spreads root-level
 *     metadata keys back onto `TraceMetadata`).
 *
 * The output is byte-stable: cycle 2 → cycle 3 produces an identical
 * file. We achieve this by sorting children by `(start, name, end)`
 * during emission and by using {@link Math.round} when converting
 * milliseconds to microseconds so float noise can't drift across
 * roundtrips.
 *
 * The result is a `ReadableStream<Uint8Array>` of gzipped bytes — no
 * DOM dependency, so this is safe to call from a worker, a Node
 * script, or a future CLI. The UI-side download trigger lives in
 * `src/components/downloadTrace.ts`.
 */

import type {
  CompactionReport,
  Mark,
  Measure,
  MeasureAttribution,
  ParsedTrace,
  System,
  Track,
  TraceSource,
} from '../types'
import {
  PFCTO_ARG_KEYS,
  PFCTO_EXPORT_METADATA_KEY,
  type PfctoExportMarker,
} from '../parsers/chrome/chrome-types'

/**
 * Schema version written to {@link PfctoExportMarker.version}. Bump when
 * a breaking change to the on-disk layout lands so tooling can detect
 * older exports and refuse / migrate.
 */
const EXPORT_SCHEMA_VERSION = 1

/**
 * Returns the conventional download filename for a given trace. Strips
 * `.json` / `.json.gz` from the source name so we don't end up with
 * `foo.json.gz.compacted.json.gz`.
 */
export function suggestExportFilename(source: TraceSource): string {
  const stem = source.name
    .replace(/\.json\.gz$/i, '')
    .replace(/\.json$/i, '')
    .replace(/\.gz$/i, '')
  return `${stem || 'trace'}.compacted.json.gz`
}

interface SerializedEvent {
  ph: string
  name: string
  cat?: string
  pid: number
  tid: number
  ts: number
  dur?: number
  s?: string
  args?: Record<string, unknown>
}

/**
 * Stream a {@link ParsedTrace} as gzipped Chrome trace JSON. Caller is
 * responsible for consuming the returned stream (writing to disk,
 * piping to a `<a download>`, posting back over the network, …).
 *
 * Throws synchronously if `CompressionStream` is unavailable in the
 * host environment — every browser we target ships it (matches the
 * `DecompressionStream` gate in `src/core/utils/decompress.ts`).
 */
export function zipCompactedTrace(trace: ParsedTrace): ReadableStream<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error(
      'zipCompactedTrace: CompressionStream is unavailable in this environment.',
    )
  }
  const jsonStream = streamCompactedJson(trace)
  return jsonStream.pipeThrough(new CompressionStream('gzip'))
}

/**
 * Same payload as {@link zipCompactedTrace} but without the gzip
 * wrapper. Exposed for tests and tooling that want to inspect the
 * raw JSON without having to round-trip through `DecompressionStream`.
 *
 * Generation is **lazy / pull-driven**: the source generator advances
 * one chunk at a time inside the ReadableStream's `pull()` callback,
 * so chunks are produced on demand as the downstream consumer (the
 * `CompressionStream` in {@link zipCompactedTrace}, or a test reader)
 * pulls them. We deliberately do NOT push everything synchronously
 * inside `start()`: doing so blocks the main thread for tens of
 * seconds on real traces and, more importantly, fills the
 * controller's internal queue past Chrome's enforced cap on a single
 * synchronous batch — at which point further `enqueue` calls error,
 * we forward via `controller.error`, and the consumer ends up with a
 * truncated gzip containing only whatever the CompressionStream had
 * already drained (in practice: just the metadata events). Pulling
 * one chunk per tick keeps the queue tiny and lets compression
 * progress alongside JSON generation. To amortize per-pull overhead
 * we bundle several small JSON chunks into a single Uint8Array
 * before yielding back to the consumer.
 */
export function streamCompactedJson(trace: ParsedTrace): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  // Target chunk size handed back to the consumer. Tuned to be large
  // enough that we don't churn it with microscopic reads (each
  // `pull` hops through the event loop) but small enough that a
  // single chunk never holds megabytes — which would re-introduce
  // the exact memory-pressure failure mode this stream was built to
  // avoid.
  const TARGET_CHUNK_BYTES = 64 * 1024
  // Iterator is captured in the per-stream closure below. Constructed
  // lazily on the first pull so a stream that's cancelled before any
  // read pays only the ReadableStream allocation.
  let iter: Generator<string> | null = null
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (iter === null) iter = generateJsonChunks(trace)
      try {
        let pendingBytes = 0
        const pieces: Uint8Array[] = []
        while (pendingBytes < TARGET_CHUNK_BYTES) {
          const next = iter.next()
          if (next.done) {
            if (pieces.length > 0) controller.enqueue(concatBytes(pieces, pendingBytes))
            controller.close()
            return
          }
          const bytes = encoder.encode(next.value)
          if (bytes.byteLength === 0) continue
          pieces.push(bytes)
          pendingBytes += bytes.byteLength
        }
        controller.enqueue(concatBytes(pieces, pendingBytes))
      } catch (err) {
        controller.error(err)
      }
    },
    cancel() {
      // Let the generator clean up if a consumer aborts mid-stream
      // (e.g. the user closes the tab while a download is in flight).
      iter?.return?.()
      iter = null
    },
  })
}

function concatBytes(pieces: Uint8Array[], total: number): Uint8Array {
  if (pieces.length === 1) return pieces[0]
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of pieces) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

/**
 * Generator yielding the trace JSON chunk-by-chunk. Each yielded
 * string is appended to a running `traceEvents` array; the helper
 * tracks comma placement via a leading `,` on every event after
 * the first.
 *
 * Top-level shape:
 *
 * ```
 * {
 *   "traceEvents": [ <M events>, <X events>, <i events> ],
 *   "displayTimeUnit": "ms",
 *   "metadata": { ...trace.metadata, _pfctoExport: { ... } }
 * }
 * ```
 */
function* generateJsonChunks(trace: ParsedTrace): Generator<string> {
  yield '{"traceEvents":['

  const state = {first: true}
  const emit = (ev: SerializedEvent): string => {
    const out = (state.first ? '' : ',') + JSON.stringify(ev)
    state.first = false
    return out
  }

  // 1. Process / thread metadata events. Emitting these first matches
  //    the convention DevTools follows and keeps the chrome parser
  //    happy regardless of where it sees thread events relative to
  //    metadata (the parser is order-insensitive on this anyway).
  yield* emitMetadataEvents(trace.timeline.systems, emit)

  // 2. Per-track measure / mark events. Prefer the flat
  //    `track.buffers` / `track.markBuffers` SoA when present —
  //    the worker boundary in `stripParsedTreeForTransfer` empties
  //    the recursive `track.measures` / `measure.measures` arrays
  //    before `postMessage` to dodge V8's structured-clone stack
  //    overflow on deep call trees. Walking the tree in that mode
  //    yields zero events. The flat buffers carry back-pointers
  //    to every Measure (with all scalar fields intact); we don't
  //    need the recursive structure because the chrome parser
  //    rebuilds nesting from `(ts, dur)` containment on re-import.
  for (let s = 0; s < trace.timeline.systems.length; s++) {
    const system = trace.timeline.systems[s]
    const pid = s + 1
    for (let t = 0; t < system.tracks.length; t++) {
      const track = system.tracks[t]
      const tid = t + 1
      yield* emitTrackEvents(track, pid, tid, emit)
    }
  }

  yield '],"displayTimeUnit":"ms"'

  // 3. Top-level `metadata` carrying both the original parser metadata
  //    (compaction counters, root-level keys the source carried) and
  //    the export marker. The chrome parser's root-key spread will
  //    pick this back up under `TraceMetadata` on re-import.
  const exportMarker: PfctoExportMarker = {
    version: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date(0).toISOString(),
    sourceName: trace.source.name,
    lossy: true,
  }
  // Wall-clock timestamps are fine for the file marker but kill
  // byte-stability across cycles. The smoke / roundtrip tests rely
  // on cycle 2 → cycle 3 producing identical bytes; using a frozen
  // epoch here keeps that property without losing the marker's
  // semantic value (we already capture `sourceName`).
  exportMarker.exportedAt = freezeExportTimestamp()

  // Strip parser-derived fields that the chrome parser will re-compute
  // on re-import (`parser`, `eventCount`, `compaction`). Embedding them
  // would push byte-stability one cycle later: cycle N's `eventCount`
  // depends on the number of events emitted by cycle N-1, which only
  // stops drifting once compaction is also stable. We re-derive them on
  // every parse, so persisting them buys nothing but breakage.
  const {parser: _p, eventCount: _ec, compaction: _comp, ...stableMetadata} = trace.metadata
  const metadataPayload: Record<string, unknown> = {
    ...stableMetadata,
    [PFCTO_EXPORT_METADATA_KEY]: exportMarker,
  }
  yield ',"metadata":'
  yield JSON.stringify(metadataPayload)
  yield '}'
}

/**
 * Frozen timestamp used in the export marker. We deliberately avoid
 * `Date.now()` so cycle 2 → cycle 3 is byte-identical; the marker is
 * still useful (carries the schema version, source name, lossy flag).
 * If a future workflow needs the real export wall-clock, add it as a
 * separate non-byte-stable field rather than mutating this one.
 */
function freezeExportTimestamp(): string {
  return '1970-01-01T00:00:00.000Z'
}

/**
 * Emit `process_name` / `process_sort_index` / `thread_name` /
 * `thread_sort_index` metadata events for every system + track.
 *
 * `process_sort_index` and `thread_sort_index` use the input array
 * indices so the chrome parser's `compareProcesses` / `compareThreads`
 * reproduces the exact original ordering on re-import.
 *
 * The track's `category` is encoded as a custom arg
 * (`_pfctoTrackCategory`) on `thread_name`. The parser's chrome ingest
 * path forces every track to `category: 'thread'` regardless, but the
 * arg is preserved so future tooling (or a smarter parser branch) can
 * inspect it.
 */
function* emitMetadataEvents(
  systems: System[],
  emit: (ev: SerializedEvent) => string,
): Generator<string> {
  for (let s = 0; s < systems.length; s++) {
    const system = systems[s]
    const pid = s + 1
    yield emit({
      ph: 'M',
      name: 'process_name',
      pid,
      tid: 0,
      ts: 0,
      args: {name: system.name},
    })
    yield emit({
      ph: 'M',
      name: 'process_sort_index',
      pid,
      tid: 0,
      ts: 0,
      args: {sort_index: s},
    })
    for (let t = 0; t < system.tracks.length; t++) {
      const track = system.tracks[t]
      const tid = t + 1
      const threadArgs: Record<string, unknown> = {name: track.name}
      if (track.category) {
        threadArgs[PFCTO_ARG_KEYS.TRACK_CATEGORY] = track.category
      }
      yield emit({
        ph: 'M',
        name: 'thread_name',
        pid,
        tid,
        ts: 0,
        args: threadArgs,
      })
      yield emit({
        ph: 'M',
        name: 'thread_sort_index',
        pid,
        tid,
        ts: 0,
        args: {sort_index: t},
      })
    }
  }
}

/**
 * Emit one `X` event per Measure and one `i` event per Mark in the
 * track. Output is sorted by `(start, name, end)` for byte-stability
 * across roundtrips.
 *
 * We do not emit explicit nesting metadata: the chrome parser rebuilds
 * the tree from `(ts, dur)` containment on re-import (the same logic
 * that handles real-world Chrome traces).
 *
 * Two source-of-truth modes:
 *
 *  - **Flat buffers** (`track.buffers` / `track.markBuffers`): used in
 *    every browser export, because the worker → main-thread transfer
 *    (`stripParsedTreeForTransfer`) empties the recursive
 *    `Measure.measures` / `track.measures` arrays before `postMessage`
 *    to avoid V8 structured-clone stack overflows on deep async
 *    stacks. The flat buffers carry back-pointers to every Measure /
 *    Mark with all scalar fields intact.
 *  - **Recursive tree** (`track.measures` / per-Measure `marks`): used
 *    by Node-side tests and the smoke roundtrip script, which never go
 *    through the worker and so retain the original tree.
 *
 * Both modes produce the same on-disk events: emission order is fixed
 * by `compareMeasures` / `compareMarks`, and per-event content is
 * derived from the same `Measure` / `Mark` objects in both paths.
 */
function* emitTrackEvents(
  track: Track,
  pid: number,
  tid: number,
  emit: (ev: SerializedEvent) => string,
): Generator<string> {
  const marks = collectTrackMarks(track)
  marks.sort(compareMarks)
  for (const mark of marks) {
    yield emit(serializeMark(mark, pid, tid))
  }

  const buffers = track.buffers
  if (buffers && buffers.count > 0) {
    // The flat buffer is already in pre-order (DFS, parent-before-
    // descendants) because the parser's `finalizeContainer` sorts
    // every container's children by `(start ASC, end DESC)` before
    // `buildSliceBuffers` flattens them. That sort matches what the
    // chrome parser will reapply on re-import, so emitting in this
    // order keeps every (ts, dur)-tied parent immediately before
    // its children. Re-sorting here would break that — when a
    // parent and a child share the same `start`, only the parent's
    // larger `end` distinguishes them. A sort that put `end ASC`
    // last (or that broke ties on `name` first) flips child before
    // parent, and the chrome parser's containment-based stack
    // builder ends up nesting the parent *inside* the child.
    for (let i = 0; i < buffers.count; i++) {
      yield emit(serializeMeasure(buffers.measures[i], pid, tid))
    }
    return
  }

  // Fallback for code paths that don't construct `track.buffers`
  // (mostly Node-side tooling and tests). Walk the recursive
  // `track.measures` tree in DFS pre-order, sorting children at
  // each level by the same `(start ASC, end DESC, name)` order the
  // parser uses so the emission is deterministic and parent ties
  // emit before children.
  yield* emitMeasureTreePreorder(track.measures, pid, tid, emit)
}

function* emitMeasureTreePreorder(
  measures: Measure[],
  pid: number,
  tid: number,
  emit: (ev: SerializedEvent) => string,
): Generator<string> {
  if (measures.length === 0) return
  const ordered = [...measures].sort(compareMeasures)
  for (const m of ordered) {
    yield emit(serializeMeasure(m, pid, tid))
    if (m.measures.length > 0) {
      yield* emitMeasureTreePreorder(m.measures, pid, tid, emit)
    }
  }
}

/**
 * Collect every `Mark` in a track's subtree as a flat array. Prefers
 * `track.markBuffers.marks` when the parser populated it (the worker
 * boundary empties the recursive `Measure.marks` arrays); falls back
 * to a recursive walk of the tree for Node-side parsers / tests that
 * skip `stripParsedTreeForTransfer`.
 */
function collectTrackMarks(track: Track): Mark[] {
  const buffers = track.markBuffers
  if (buffers && buffers.count > 0) {
    return buffers.marks.slice(0, buffers.count)
  }
  const out: Mark[] = []
  for (const m of track.marks) out.push(m)
  if (track.measures.length > 0) collectMarksRecursive(track.measures, out)
  return out
}

function collectMarksRecursive(measures: Measure[], out: Mark[]): void {
  for (const m of measures) {
    for (const mark of m.marks) out.push(mark)
    if (m.measures.length > 0) collectMarksRecursive(m.measures, out)
  }
}

/**
 * Order children inside a single container. Matches the parser's
 * own `compareByStart` (in `chrome-parser.ts`):
 *
 *   - Earlier `start` first.
 *   - On `start` ties, **larger `end` first** so a parent emits
 *     before its same-start children. The chrome parser rebuilds
 *     nesting from emission order on `(ts, dur)` ties, so flipping
 *     this would invert the call tree.
 *   - On full `(start, end)` ties, alphabetical `name` for stability.
 */
function compareMeasures(a: Measure, b: Measure): number {
  if (a.start !== b.start) return a.start - b.start
  if (a.end !== b.end) return b.end - a.end
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return 0
}

function compareMarks(a: Mark, b: Mark): number {
  if (a.time !== b.time) return a.time - b.time
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return 0
}

/**
 * Convert a Measure into a Chrome `X` (Complete) event. Time fields
 * are emitted in microseconds (the chrome trace canonical unit) using
 * `Math.round` so float noise from the parse-side `(ts - origin)/1000`
 * never drifts across export roundtrips.
 *
 * Non-roundtrip-essential fields (color, attribution, compaction)
 * land under `args` with the `_pfcto` prefix.
 */
function serializeMeasure(measure: Measure, pid: number, tid: number): SerializedEvent {
  const tsUs = msToUs(measure.start)
  const durUs = msToUs(measure.end - measure.start)
  const args = buildMeasureArgs(measure)
  const ev: SerializedEvent = {
    ph: 'X',
    name: measure.name,
    pid,
    tid,
    ts: tsUs,
    dur: durUs >= 0 ? durUs : 0,
  }
  if (measure.category) ev.cat = measure.category
  if (args) ev.args = args
  return ev
}

function serializeMark(mark: Mark, pid: number, tid: number): SerializedEvent {
  const ev: SerializedEvent = {
    ph: 'i',
    name: mark.name,
    pid,
    tid,
    ts: msToUs(mark.time),
    s: 'g',
  }
  if (mark.category) ev.cat = mark.category
  return ev
}

function buildMeasureArgs(measure: Measure): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  if (measure.compaction && measure.compaction.length > 0) {
    out[PFCTO_ARG_KEYS.COMPACTION] = measure.compaction.map(serializeCompactionReport)
  }
  if (measure.color) {
    out[PFCTO_ARG_KEYS.COLOR] = measure.color
  }
  if (measure.attribution) {
    out[PFCTO_ARG_KEYS.ATTRIBUTION] = serializeAttribution(measure.attribution)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function serializeCompactionReport(report: CompactionReport): CompactionReport {
  // Spread to drop accidental extras and lock key order across
  // versions. JSON.stringify preserves insertion order, so writing
  // these in a fixed sequence keeps the emitted bytes byte-stable
  // across cycles.
  const out: CompactionReport = {
    origin: report.origin,
    names: [...report.names],
    count: report.count,
    firstTs: report.firstTs,
    lastTs: report.lastTs,
    totalDurationMs: report.totalDurationMs,
  }
  if (report.category !== undefined) out.category = report.category
  if (report.maxDepthFolded !== undefined) out.maxDepthFolded = report.maxDepthFolded
  if (report.distinctNames !== undefined) out.distinctNames = report.distinctNames
  if (report.nameDurationsMs !== undefined) {
    out.nameDurationsMs = [...report.nameDurationsMs]
  }
  if (report.subtreesMerged !== undefined) out.subtreesMerged = report.subtreesMerged
  return out
}

function serializeAttribution(attribution: MeasureAttribution): MeasureAttribution {
  const out: MeasureAttribution = {
    kind: 'callsite',
    label: attribution.label,
  }
  if (attribution.source !== undefined) out.source = attribution.source
  if (attribution.location !== undefined) {
    const loc: NonNullable<MeasureAttribution['location']> = {}
    if (attribution.location.url !== undefined) loc.url = attribution.location.url
    if (attribution.location.lineNumber !== undefined) {
      loc.lineNumber = attribution.location.lineNumber
    }
    if (attribution.location.columnNumber !== undefined) {
      loc.columnNumber = attribution.location.columnNumber
    }
    out.location = loc
  }
  return out
}

/**
 * Round milliseconds to microseconds. Using `Math.round` avoids drift
 * across roundtrips: a Measure produced by parsing 5 µs is `0.005`
 * ms in float; emitting `0.005 * 1000 = 5.000000000000001` then
 * stringifying would sometimes serialize as `5.000000000000001`,
 * widening the trace and losing byte-stability. `Math.round(5.0…1)`
 * → `5`, which then re-parses to exactly `0.005` ms.
 */
function msToUs(ms: number): number {
  return Math.round(ms * 1000)
}
