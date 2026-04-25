import {JSONParser} from '@streamparser/json'

import type {
  Mark,
  Measure,
  ParsedTrace,
  RawEvent,
  System,
  TimelineContainer,
  Track,
  TraceMetadata,
  TraceSource,
} from '../../types'
import {
  buildMarkBuffers,
  buildSliceBuffers,
  buildSliceMipmap,
} from '../../render/sliceBuffers'
import {yieldToEventLoop} from '../../utils/yieldToEventLoop'
import type {FinalizeOptions, TraceParser} from '../types'
import {
  compactCpuTinyFrames,
  compactSiblings,
  DEFAULT_CPU_TINY_OPTIONS,
  DEFAULT_SIBLING_COMPACTION_OPTIONS,
  emptyCompactionCounters,
  type CompactionCounters,
} from '../compaction'
import {cullSubpixelSubtrees, DEFAULT_SUBPIXEL_CULL_OPTIONS} from '../cull'
import {
  asyncKey,
  counterKey,
  cpuProfileKey,
  isAsyncPh,
  isComplete,
  isCounterPh,
  isDurationBegin,
  isDurationEnd,
  isInstantPh,
  isMetadataPh,
  isSamplePh,
  type ChromeEvent,
  type ChromeParserOptions,
  type CpuCallFrame,
  type CpuNode,
  type CpuProfile,
} from './chrome-types'

const V8_GC_INTERNAL_NAME = /^V8\.GC_/
const JS_FRAME_CATEGORY = 'jsFrame'
const JS_HOST_OVERSHOOT_EPSILON_MS = 0.05

/**
 * Names of synthetic CPU-profile nodes that should not be rendered as their
 * own frames. `(root)` is the tree root; `(garbage collector)` is V8's
 * internal GC pseudo-frame that DevTools typically folds into the parent GC
 * slice rather than drawing at call-stack depth.
 */
const HIDDEN_CPU_NODE_NAMES = new Set(['(root)', '(garbage collector)'])

/**
 * Names treated as "no JS running" — when the entire remaining call stack
 * resolves to just one of these, we close any open JS frames instead of
 * opening a new one. Matches DevTools' treatment of `(program)` / `(idle)`.
 */
const IDLE_CPU_NODE_NAMES = new Set(['(program)', '(idle)'])

const MAGIC = new TextEncoder().encode('"traceEvents"')
/**
 * Shared frozen empty RawEvent[] handed to every Measure/Mark so we
 * don't allocate a fresh 0-length array per event. At hundreds of
 * millions of events that's the difference between a few hundred MB
 * and a few GB of v8 headers.
 */
const EMPTY_RAW_EVENTS: RawEvent[] = Object.freeze([]) as unknown as RawEvent[]

/**
 * Per-thread event count at which the online compactor starts merging
 * adjacent same-(name,cat) sub-threshold X events into single synthetic
 * X records. 2M is well below typical v8 heap limits for a raw
 * ChromeEvent[] (~400-800 MB), so we leave a safety margin before the
 * full finalize tree doubles the footprint.
 */
const STREAMING_CAP_EVENTS = 2_000_000
/**
 * Trace-wide event-count threshold below which we skip the finalize
 * sibling compactor entirely. On a typical dev trace (tens of
 * thousands of events) every Measure paints fine and folding any of
 * them only loses information from the user's flame chart. Above the
 * threshold the compactor still applies its own size gates (leaf-only,
 * sub-visible duration, span fraction) so it only ever folds genuine
 * sub-pixel clutter. CPU-profile tiny-frame compaction runs at every
 * size — it's targeted at synthesized `jsFrame` subtrees where the
 * fold _is_ the desired rendering.
 */
const COMPACTION_MIN_EVENTS = 500_000
/**
 * Per-track raw-event-count threshold at or above which the
 * highest-point subpixel-subtree cull engages on that track. The
 * failing-trace investigation found per-thread event counts in the
 * hundreds of thousands; 100k is comfortably below that while still
 * leaving small dev traces (which never produce sub-pixel clutter
 * worth folding) untouched. Overridable via
 * `ChromeParserOptions.subpixelCullMinEventsPerTrack` so unit tests
 * can exercise the cull on synthetic fixtures.
 */
const SUBPIXEL_CULL_MIN_EVENTS_PER_TRACK = 100_000
/**
 * Maximum `dur` (in µs) an X event can have and still be eligible for
 * online merging. Events wider than this keep their identity because
 * they're likely to be visible at fit-zoom.
 */
const ONLINE_MERGE_MAX_DUR_US = 500
/** Sentinel field on a ChromeEvent marking it as an online-merged record. */
const ONLINE_MERGED_ARGS_KEY = '_pfctoMerged'

interface OnlineMergeRecord {
  count: number
  firstTs: number
  lastTs: number
  totalDur: number
}

function extractOnlineMergeRecord(ev: ChromeEvent): OnlineMergeRecord | null {
  const args = ev.args as {[ONLINE_MERGED_ARGS_KEY]?: OnlineMergeRecord} | undefined
  if (!args) return null
  const rec = args[ONLINE_MERGED_ARGS_KEY]
  if (!rec || typeof rec.count !== 'number') return null
  return rec
}

/**
 * Shared string interner. `@streamparser/json` emits fresh primitive
 * strings per event; on a trace with 200M events and only a few hundred
 * distinct name/cat values, deduping reclaims the overhead of repeated
 * string headers. Interning is `O(1)` per call via a Map lookup; miss
 * cost is one Map set.
 */
class StringTable {
  private readonly _map = new Map<string, string>()

  intern(s: string): string {
    const hit = this._map.get(s)
    if (hit !== undefined) return hit
    this._map.set(s, s)
    return s
  }

  get size(): number {
    return this._map.size
  }
}
const ROOT_METADATA_FIELDS = new Set([
  'metadata',
  'displayTimeUnit',
  'otherData',
  'systemTraceEvents',
])

interface ProcessInfo {
  pid: number
  name?: string
  sortIndex?: number
  threads: Map<number, ThreadInfo>
  /** Preserves first-seen order of threads for stable output when no sort_index is given. */
  threadOrder: number[]
  discoveryIndex: number
}

interface ThreadInfo {
  tid: number
  name?: string
  sortIndex?: number
  events: ChromeEvent[]
}

interface Frame {
  event: ChromeEvent
  children: Measure[]
  marks: Mark[]
  /** True when this frame came from an `X` (complete) event with a known end. */
  isComplete: boolean
  /** For complete frames, the pre-computed end timestamp (ev.ts + ev.dur). */
  endTs: number
}

/**
 * Streaming parser for the Chrome Trace Event Format (JSON Object form).
 *
 * The universal entry wires bytes in via {@link write}; we internally run the
 * stream through `@streamparser/json` with path selectors so each traceEvents
 * element is delivered one-by-one. On {@link finalize} we sort per-thread event
 * streams, build nested Measure trees, and produce a {@link ParsedTrace}.
 *
 * Supported phases: B/E/X (durations), I/i/R (instants), M (metadata,
 * populates process/thread names), b/e/n (async), C (counter), and P
 * (samples) — `Profile` opens a V8 CPU profile, `ProfileChunk`s carry its
 * node tree + delta-encoded samples, both merged at finalize into
 * synthesized JS-frame Measures on the owning thread. Flow, object-lifetime,
 * and clock-sync events are still ignored.
 */
export class ChromeParser implements TraceParser {
  static readonly MAGIC_PATTERN: Uint8Array = MAGIC
  static readonly parserName = 'chrome'

  private readonly _json_parser: JSONParser
  private readonly _options: Required<ChromeParserOptions>
  private _error: Error | null = null
  private _rootMetadata: Record<string, unknown> = {}
  private _processes = new Map<number, ProcessInfo>()
  private _processDiscoveryCounter = 0
  private _asyncByKey = new Map<string, ChromeEvent[]>()
  private _asyncPidByKey = new Map<string, number>()
  private _countersByKey = new Map<string, ChromeEvent[]>()
  private _counterPidByKey = new Map<string, number>()
  private _cpuProfiles = new Map<string, CpuProfile>()
  private _eventCount = 0
  private _minTs = Number.POSITIVE_INFINITY
  private _maxTs = Number.NEGATIVE_INFINITY
  private _idCounter = 0
  /**
   * Running compaction counters. Populated during finalize (sibling +
   * CPU-tiny-frame passes) and surfaced on `metadata.compaction` so
   * UI code can show "N events folded" without re-scanning the tree.
   * Online counters (from the streaming cap in {@link ThreadEventBuffer})
   * merge into the same struct before finalize runs its passes.
   */
  private _compactionCounters: CompactionCounters = emptyCompactionCounters()
  private _onlineEventsFolded = 0
  private _onlineTriggered = false
  /**
   * Interns name/cat strings so repeated events on huge traces don't
   * each carry their own heap-allocated string. Benchmarks: a 3M-event
   * DevTools trace sees ~85% dedupe on `name` alone.
   */
  private _strings = new StringTable()

  constructor(options?: unknown) {
    const opts = isChromeParserOptions(options) ? options : {}
    this._options = {
      collapseGcInternals: opts.collapseGcInternals ?? true,
      compactionMinEvents: opts.compactionMinEvents ?? COMPACTION_MIN_EVENTS,
      subpixelCullMinEventsPerTrack:
        opts.subpixelCullMinEventsPerTrack ?? SUBPIXEL_CULL_MIN_EVENTS_PER_TRACK,
    }
    this._json_parser = new JSONParser({
      paths: [
        '$.traceEvents.*',
        '$.metadata',
        '$.displayTimeUnit',
        '$.otherData',
        '$.systemTraceEvents',
      ],
      keepStack: false,
    })

    this._json_parser.onValue = ({value, stack, key}) => {
      if (stack.length === 2 && stack[1]?.key === 'traceEvents') {
        this._handleEvent(value as ChromeEvent)
        return
      }
      if (stack.length === 1 && typeof key === 'string' && ROOT_METADATA_FIELDS.has(key)) {
        if (key === 'metadata' && value && typeof value === 'object' && !Array.isArray(value)) {
          Object.assign(this._rootMetadata, value as Record<string, unknown>)
        } else {
          this._rootMetadata[key] = value as unknown
        }
      }
    }

    this._json_parser.onError = err => {
      this._error = err
    }
  }

  write(chunk: Uint8Array): void {
    if (this._error) throw this._error
    this._json_parser.write(chunk)
  }

  async finalize(source: TraceSource, options?: FinalizeOptions): Promise<ParsedTrace> {
    if (!this._json_parser.isEnded) {
      try {
        this._json_parser.end()
      } catch {
        // Surfaced via onError below.
      }
    }
    // When the universal parser truncated the input on purpose
    // (`maxBytes` cap), the JSON parser will have flagged an
    // "incomplete JSON" error on `.end()`. Swallow it: every event
    // that *did* fully parse is still on `_processes`, and the user
    // would rather see a partial flame chart than nothing.
    if (this._error && !options?.truncated) throw this._error
    return this._buildParsedTrace(source, options)
  }

  // --- ingest --------------------------------------------------------------

  private _handleEvent(ev: ChromeEvent): void {
    if (!ev || typeof ev !== 'object') return
    const ph = ev.ph
    if (typeof ph !== 'string') return

    const pid = Number(ev.pid)
    const tid = Number(ev.tid)
    if (!Number.isFinite(pid) || !Number.isFinite(tid)) return
    ev.pid = pid
    ev.tid = tid
    // Intern the two hot strings so repeated events don't each own a
    // heap-allocated copy. Rough-stats on huge traces show ~85% dedupe.
    if (typeof ev.name === 'string') ev.name = this._strings.intern(ev.name)
    if (typeof ev.cat === 'string') ev.cat = this._strings.intern(ev.cat)

    if (isMetadataPh(ph)) {
      this._eventCount += 1
      this._ingestMetadata(ev)
      return
    }

    // V8 internal GC phase slices (V8.GC_HEAP_*, V8.GC_SCAVENGER_*, …)
    // balloon the main-thread flame chart into a tower of sub-microsecond
    // leaves under every MinorGC / V8.GCScavenger. DevTools hides these
    // behind a single "Minor GC" bar; we do the same unless callers opt in
    // to the raw tree via `collapseGcInternals: false`.
    if (
      this._options.collapseGcInternals &&
      typeof ev.name === 'string' &&
      V8_GC_INTERNAL_NAME.test(ev.name)
    ) {
      return
    }

    this._eventCount += 1

    if (typeof ev.ts === 'number' && Number.isFinite(ev.ts)) {
      if (ev.ts < this._minTs) this._minTs = ev.ts
      const end = ev.ts + (typeof ev.dur === 'number' ? ev.dur : 0)
      if (end > this._maxTs) this._maxTs = end
    }

    if (isSamplePh(ph)) {
      this._ingestSample(ev)
      return
    }

    if (isAsyncPh(ph)) {
      const k = asyncKey(ev)
      this._pushMap(this._asyncByKey, k, ev)
      this._asyncPidByKey.set(k, pid)
      this._touchProcess(pid)
      return
    }

    if (isCounterPh(ph)) {
      const k = counterKey(ev)
      this._pushMap(this._countersByKey, k, ev)
      this._counterPidByKey.set(k, pid)
      this._touchProcess(pid)
      return
    }

    if (isDurationBegin(ph) || isDurationEnd(ph) || isComplete(ph) || isInstantPh(ph)) {
      const proc = this._touchProcess(pid)
      const thread = this._touchThread(proc, tid)
      if (
        isComplete(ph) &&
        thread.events.length >= STREAMING_CAP_EVENTS &&
        this._tryOnlineMerge(thread, ev)
      ) {
        return
      }
      thread.events.push(ev)
    }
  }

  /**
   * Online compactor: when a thread crosses {@link STREAMING_CAP_EVENTS},
   * try to merge a newly-arrived `X` event into the last-seen event on
   * that thread. Conditions to merge:
   *
   *   1. The new event has the same `(name, cat)` as the previous.
   *   2. Both events' durations are under {@link ONLINE_MERGE_MAX_DUR_US}
   *      so we don't visually hide anything the user would have seen at
   *      fit-zoom.
   *   3. The previous event is itself a leaf-ish `X` (not a wrapper with
   *      recorded children) — we check by looking at the ts delta, not
   *      by re-scanning subsequent events, so the decision stays O(1).
   *
   * When all three hold we update the previous event in-place with an
   * `_pfctoMerged` record under `args` and bump the aggregate duration.
   * Finalize recognizes this marker and emits a Measure carrying a
   * {@link CompactionReport} with `origin: 'sibling'` — the same shape
   * the finalize sibling compactor emits, so UI code handles both
   * uniformly.
   *
   * Returns `true` iff the event was merged (and therefore should not
   * be pushed).
   */
  private _tryOnlineMerge(thread: ThreadInfo, ev: ChromeEvent): boolean {
    const dur = typeof ev.dur === 'number' ? ev.dur : 0
    if (dur <= 0 || dur > ONLINE_MERGE_MAX_DUR_US) return false
    const prev = thread.events[thread.events.length - 1]
    if (!prev || prev.ph !== 'X') return false
    if (prev.name !== ev.name || prev.cat !== ev.cat) return false
    const prevDur = typeof prev.dur === 'number' ? prev.dur : 0
    if (prevDur > ONLINE_MERGE_MAX_DUR_US) return false
    // Require the previous event to end before or at the new event's
    // start — overlap would mean they're nested, not peers.
    const prevEnd = prev.ts + prevDur
    if (prevEnd > ev.ts) return false

    const args = (prev.args ?? {}) as Record<string, unknown>
    let record = args[ONLINE_MERGED_ARGS_KEY] as OnlineMergeRecord | undefined
    if (!record) {
      record = {
        count: 1,
        firstTs: prev.ts,
        lastTs: prevEnd,
        totalDur: prevDur,
      }
      args[ONLINE_MERGED_ARGS_KEY] = record
      prev.args = args
    }
    record.count += 1
    record.lastTs = ev.ts + dur
    record.totalDur += dur
    // Widen the stored `dur` so downstream logic that reads `ts + dur`
    // still sees the merged span. The run's ts stays at the first
    // event's ts (prev.ts) — which is exactly firstTs.
    prev.dur = record.lastTs - record.firstTs

    this._onlineEventsFolded += 1
    this._onlineTriggered = true
    return true
  }

  /**
   * V8 CPU-profile frames arrive as a `Profile` event (opens a profile,
   * specifies the thread it belongs to) plus a sequence of `ProfileChunk`
   * events on the profiler's own thread carrying delta-encoded node
   * definitions and sample indices. We accumulate both into a
   * {@link CpuProfile} so finalize can synthesize JS-frame Measures on the
   * owning thread.
   */
  private _ingestSample(ev: ChromeEvent): void {
    const key = cpuProfileKey(ev.pid, ev.id)
    const data = (ev.args as {data?: Record<string, unknown>} | undefined)?.data
    if (ev.name === 'Profile') {
      const existing = this._cpuProfiles.get(key)
      const startTs =
        typeof data?.startTime === 'number' ? (data.startTime as number) : ev.ts
      if (existing) {
        existing.ownerTid = ev.tid
        existing.startTs = startTs
      } else {
        this._cpuProfiles.set(key, {
          key,
          pid: ev.pid,
          ownerTid: ev.tid,
          startTs,
          nodes: new Map(),
          samples: [],
          timeDeltas: [],
        })
      }
      const owner = this._touchProcess(ev.pid)
      this._touchThread(owner, ev.tid)
      return
    }
    if (ev.name === 'ProfileChunk') {
      let profile = this._cpuProfiles.get(key)
      if (!profile) {
        // Missing `Profile` opener — rare but allowed by the spec. Use the
        // chunk's own tid as a placeholder owner; a later `Profile` event
        // with the same id will correct it.
        profile = {
          key,
          pid: ev.pid,
          ownerTid: ev.tid,
          startTs: ev.ts,
          nodes: new Map(),
          samples: [],
          timeDeltas: [],
        }
        this._cpuProfiles.set(key, profile)
      }
      const cpuProfile = data?.cpuProfile as
        | {nodes?: CpuNode[]; samples?: number[]}
        | undefined
      if (cpuProfile?.nodes) {
        for (const node of cpuProfile.nodes) {
          if (typeof node?.id === 'number') profile.nodes.set(node.id, node)
        }
      }
      if (Array.isArray(cpuProfile?.samples)) {
        profile.samples.push(...(cpuProfile.samples as number[]))
      }
      if (Array.isArray(data?.timeDeltas)) {
        profile.timeDeltas.push(...(data.timeDeltas as number[]))
      }
    }
  }

  private _ingestMetadata(ev: ChromeEvent): void {
    const proc = this._touchProcess(ev.pid)
    const args = (ev.args ?? {}) as Record<string, unknown>

    switch (ev.name) {
      case 'process_name':
        if (typeof args.name === 'string') proc.name = args.name
        break
      case 'process_sort_index':
        if (typeof args.sort_index === 'number') proc.sortIndex = args.sort_index
        break
      case 'thread_name': {
        const thread = this._touchThread(proc, ev.tid)
        if (typeof args.name === 'string') thread.name = args.name
        break
      }
      case 'thread_sort_index': {
        const thread = this._touchThread(proc, ev.tid)
        if (typeof args.sort_index === 'number') thread.sortIndex = args.sort_index
        break
      }
    }
  }

  private _touchProcess(pid: number): ProcessInfo {
    let p = this._processes.get(pid)
    if (!p) {
      p = {
        pid,
        threads: new Map(),
        threadOrder: [],
        discoveryIndex: this._processDiscoveryCounter++,
      }
      this._processes.set(pid, p)
    }
    return p
  }

  private _touchThread(proc: ProcessInfo, tid: number): ThreadInfo {
    let t = proc.threads.get(tid)
    if (!t) {
      t = {tid, events: []}
      proc.threads.set(tid, t)
      proc.threadOrder.push(tid)
    }
    return t
  }

  private _pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const arr = map.get(key)
    if (arr) arr.push(value)
    else map.set(key, [value])
  }

  // --- build ---------------------------------------------------------------

  private async _buildParsedTrace(
    source: TraceSource,
    options?: FinalizeOptions,
  ): Promise<ParsedTrace> {
    const timeOrigin = Number.isFinite(this._minTs) ? this._minTs : 0
    const toMs = (ts: number): number => (ts - timeOrigin) / 1000

    const processes = [...this._processes.values()].sort(compareProcesses)
    const systems: System[] = []

    const signal = options?.signal
    const onProgress = options?.onProgress
    const baseBytesRead = options?.bytesRead ?? 0
    const streamIndex = options?.streamIndex ?? 0
    // Throttle finalize-phase progress pumps to 50 ms. Without this a
    // 64-process trace spams the worker message channel so hard that the
    // main-thread render loop can't keep up with progress redraws. The
    // universal parser already throttles the `parsing` phase; this
    // mirrors that cadence for finalize.
    const FINALIZE_PROGRESS_MIN_INTERVAL_MS = 50
    let lastProgressAt = 0

    // Pre-compute the total finalize work across every (track × stage)
    // so the UI can render a fraction-of-finalize bar instead of
    // sitting at 100% for tens of seconds. We use raw thread event
    // counts as the unit because that's what dominates per-track
    // finalize cost (cull + compact + fixup all walk the Measure
    // tree, which is bounded by the source event count). Async /
    // counter tracks add a fixed nominal cost so they still show up
    // in the progress bar but don't dominate.
    const FINALIZE_STAGES_PER_TRACK = 3
    const ASYNC_COUNTER_TRACK_NOMINAL_EVENTS = 100
    let eventsProcessed = 0
    let eventsTotal = 0
    for (const proc of processes) {
      for (const thread of proc.threads.values()) {
        if (thread.events.length === 0) continue
        eventsTotal += thread.events.length * FINALIZE_STAGES_PER_TRACK
      }
    }
    if (eventsTotal === 0) eventsTotal = 1 // avoid div-by-zero in the UI

    const emitFinalizeProgress = (detail?: string, force = false): void => {
      if (!onProgress) return
      const now = (globalThis.performance?.now?.() ?? Date.now())
      if (!force && now - lastProgressAt < FINALIZE_PROGRESS_MIN_INTERVAL_MS) return
      lastProgressAt = now
      onProgress({
        streamIndex,
        bytesRead: baseBytesRead,
        phase: 'finalizing',
        detail,
        events: {processed: eventsProcessed, total: eventsTotal},
      })
    }
    // Always fire once at the start so the UI flips out of 'parsing'.
    emitFinalizeProgress(undefined, true)

    let procIdx = 0
    const procTotal = processes.length
    for (const proc of processes) {
      procIdx += 1
      throwIfAborted(signal)
      // Yield before each process so the host event loop stays live even if we
      // end up on a trace with one monstrous process.
      await yieldToEventLoop()
      const procLabel = proc.name ?? `Process ${proc.pid}`
      emitFinalizeProgress(`Finalizing ${procLabel} (${procIdx}/${procTotal})`)

      const tracks: Track[] = []
      // Parallel array tracking the source event count per track.
      // Used for progress weighting + the cull's per-track event-count
      // gate. Async/counter tracks aren't backed by a thread, so we
      // give them a small nominal cost that's still visible on the
      // progress bar but never dominates.
      const trackEventCounts: number[] = []

      const threads = [...proc.threads.values()].sort((a, b) =>
        compareThreads(a, b, proc.threadOrder),
      )
      for (const thread of threads) {
        if (thread.events.length === 0) continue
        tracks.push(this._buildThreadTrack(proc, thread, toMs))
        trackEventCounts.push(thread.events.length)
      }

      const asyncTrack = this._buildAsyncTrack(proc.pid, toMs)
      if (asyncTrack) {
        tracks.push(asyncTrack)
        trackEventCounts.push(ASYNC_COUNTER_TRACK_NOMINAL_EVENTS)
      }

      for (const counterTrack of this._buildCounterTracks(proc.pid, toMs)) {
        tracks.push(counterTrack)
        trackEventCounts.push(ASYNC_COUNTER_TRACK_NOMINAL_EVENTS)
      }

      if (tracks.length === 0) continue

      // Sibling compaction is only worth doing when the trace is large
      // enough that we genuinely can't keep every event around. On a
      // typical-sized dev trace (tens of thousands of events) every
      // measure renders fine and folding any of them only loses
      // information from the user's flame chart. Above the threshold
      // we trust the size-aware compactor heuristics (leaf-only, sub-
      // visible per-event duration, span gates) to fold only sampler
      // bursts and tight-loop noise.
      const siblingCompactionEnabled =
        this._eventCount >= this._options.compactionMinEvents
      const subpixelCullThreshold = this._options.subpixelCullMinEventsPerTrack

      let trackIdx = 0
      const trackTotal = tracks.length
      for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti]
        const trackEvents = trackEventCounts[ti]
        trackIdx += 1
        const cullEnabled = trackEvents >= subpixelCullThreshold
        // Yield so the worker can drain its outgoing message queue
        // (progress pumps, abort requests). Big single-process traces
        // — a 60+s renderer with millions of CPU samples — used to
        // execute this whole loop in one synchronous burst, hiding
        // the finalize phase behind what looked like a hung worker.
        await yieldToEventLoop()

        // --- Pass A: highest-point sub-pixel subtree cull -----------
        emitFinalizeProgress(
          `Culling ${procLabel} — ${track.name} (${trackIdx}/${trackTotal})` +
            (cullEnabled ? '' : ' [skipped: small track]'),
        )
        if (cullEnabled) {
          cullSubpixelSubtrees(
            track,
            DEFAULT_SUBPIXEL_CULL_OPTIONS,
            () => this._nextId(),
            this._compactionCounters,
          )
        }
        eventsProcessed += trackEvents
        emitFinalizeProgress()

        // --- Pre-sort: compactSiblings/CPU-tiny expect sorted input ---
        finalizeContainer(track)

        // --- Pass B: targeted compaction (CPU-tiny + same-name siblings) ---
        emitFinalizeProgress(
          `Compacting ${procLabel} — ${track.name} (${trackIdx}/${trackTotal})`,
        )
        // CPU-profile tiny-frame compaction is always safe: it only
        // touches synthesized `jsFrame` subtrees produced from V8
        // samples, where folding sub-pixel leaf clusters into a single
        // density rect is the explicit goal. Skipping it would mean
        // tens of thousands of singleton frames render as the same
        // visual smear but cost real memory.
        for (const root of track.measures) {
          compactCpuTinyFrames(
            root,
            DEFAULT_CPU_TINY_OPTIONS,
            () => this._nextId(),
            this._compactionCounters,
          )
        }
        if (siblingCompactionEnabled) {
          // Fold runs of same-(category,name) leaf siblings across the
          // whole subtree. Uses the track's total span as the top-level
          // parent span so root-level folds apply the fraction predicate.
          const trackSpan = (track.maxEnd ?? 0) - 0
          compactSiblings(
            track,
            DEFAULT_SIBLING_COMPACTION_OPTIONS,
            () => this._nextId(),
            this._compactionCounters,
            trackSpan,
          )
        }
        eventsProcessed += trackEvents
        emitFinalizeProgress()

        // --- Pass C: fixup (re-sort) + flat-buffer build -------------
        emitFinalizeProgress(
          `Building buffers for ${procLabel} — ${track.name} (${trackIdx}/${trackTotal})`,
        )
        await yieldToEventLoop()
        // Compaction may have mutated `measures` arrays — rerun the
        // sort/maxEnd pass so SliceBuffers + mipmap see a well-formed
        // tree. finalizeContainer is idempotent on already-sorted input.
        finalizeContainer(track)
        // Once containers are sorted + maxEnd-tagged, flatten the whole
        // subtree into typed arrays. This is the data the canvas renderer
        // actually reads; the Measure[] tree sticks around as the source of
        // truth for the Aggregator / hover panes.
        track.buffers = buildSliceBuffers(track)
        track.markBuffers = buildMarkBuffers(track)
        // Phase 2 LOD: density-tinted buckets layered on top of the raw
        // buffer. Cheap to build (O(n log n)) and zoomed-out renders read it
        // instead of the raw flat list to stay viewport-bounded.
        track.mipmap = buildSliceMipmap(track.buffers)
        eventsProcessed += trackEvents
        emitFinalizeProgress()
      }

      systems.push({
        id: `sys-${proc.pid}`,
        name: proc.name ?? `Process ${proc.pid}`,
        tracks,
      })
    }

    // Snap progress to 100% so the bar doesn't sit at 99% while the
    // universal parser flips us to `'done'`. Force the emit through
    // the throttle since it's the last finalize message we'll send.
    eventsProcessed = eventsTotal
    emitFinalizeProgress(undefined, true)

    const timeline = {
      start: 0,
      end: Number.isFinite(this._minTs) && Number.isFinite(this._maxTs) ? toMs(this._maxTs) : 0,
      systems,
    }

    const metadata: TraceMetadata = {
      ...this._rootMetadata,
      parser: 'chrome',
      eventCount: this._eventCount,
      compaction: {
        onlineEventsFolded: this._onlineEventsFolded,
        onlineTriggered: this._onlineTriggered,
        siblingRunsFolded: this._compactionCounters.siblingRunsFolded,
        siblingEventsFolded: this._compactionCounters.siblingEventsFolded,
        cpuTinyRunsFolded: this._compactionCounters.cpuTinyRunsFolded,
        cpuTinyEventsFolded: this._compactionCounters.cpuTinyEventsFolded,
        subpixelSubtreesFolded: this._compactionCounters.subpixelSubtreesFolded,
        subpixelEventsFolded: this._compactionCounters.subpixelEventsFolded,
        subpixelMaxDepthFolded: this._compactionCounters.subpixelMaxDepthFolded,
      },
    }

    return {source, metadata, timeline}
  }

  private _buildThreadTrack(
    proc: ProcessInfo,
    thread: ThreadInfo,
    toMs: (ts: number) => number,
  ): Track {
    const sorted = stableSortByTs(thread.events)
    const rootMarks: Mark[] = []
    const rootMeasures: Measure[] = []
    const stack: Frame[] = []

    const currentContainer = (): {marks: Mark[]; measures: Measure[]} => {
      const top = stack[stack.length - 1]
      return top
        ? {marks: top.marks, measures: top.children}
        : {marks: rootMarks, measures: rootMeasures}
    }

    // Pops any open `X` (complete) frames whose end has been reached by `ts`,
    // attaching them to the container that is now on top of the stack (their
    // real parent). Must be called before touching `currentContainer()` so new
    // events don't get misfiled into a frame that has already ended.
    const flushCompleteFrames = (ts: number): void => {
      while (stack.length > 0) {
        const top = stack[stack.length - 1]
        if (!top.isComplete || top.endTs > ts) break
        stack.pop()
        currentContainer().measures.push(this._makeMeasureFromFrame(top, top.endTs, null, toMs))
      }
    }

    for (const ev of sorted) {
      const ph = ev.ph
      flushCompleteFrames(ev.ts)

      if (isDurationBegin(ph)) {
        stack.push({event: ev, children: [], marks: [], isComplete: false, endTs: 0})
        continue
      }

      if (isDurationEnd(ph)) {
        // If any complete frames are still open and extend past this E, treat
        // them as children and clamp their end to ev.ts. Malformed but rare.
        while (stack.length > 0 && stack[stack.length - 1].isComplete) {
          const xf = stack.pop()!
          const clamped = xf.endTs < ev.ts ? xf.endTs : ev.ts
          currentContainer().measures.push(this._makeMeasureFromFrame(xf, clamped, null, toMs))
        }
        const frame = stack.pop()
        if (!frame) continue
        currentContainer().measures.push(this._makeMeasureFromFrame(frame, ev.ts, ev, toMs))
        continue
      }

      if (isComplete(ph)) {
        const start = ev.ts
        const dur = typeof ev.dur === 'number' ? ev.dur : 0
        stack.push({
          event: ev,
          children: [],
          marks: [],
          isComplete: true,
          endTs: start + dur,
        })
        continue
      }

      if (isInstantPh(ph)) {
        currentContainer().marks.push(this._makeMark(ev, toMs))
        continue
      }
    }

    // Close any frames left open at the trace end. Complete frames get their
    // own computed end; unmatched B frames fall back to the overall max ts.
    const fallbackEnd = Number.isFinite(this._maxTs)
      ? this._maxTs
      : stack.length > 0
        ? stack[stack.length - 1].event.ts
        : 0
    while (stack.length > 0) {
      const frame = stack.pop()!
      const end = frame.isComplete ? frame.endTs : fallbackEnd
      currentContainer().measures.push(this._makeMeasureFromFrame(frame, end, null, toMs))
    }

    // Merge any V8 CPU-profile samples whose Profile was opened on this
    // thread. Produces synthesized JS-frame Measures and attaches each
    // depth-0 root under the innermost X-slice that covers its start time,
    // so the flame chart reads like DevTools' (EvaluateScript → (anonymous)
    // → user fn → …).
    this._attachJsFramesForThread(proc, thread, rootMeasures, toMs)

    return {
      id: `trk-${proc.pid}-${thread.tid}`,
      name: thread.name ?? `Thread ${thread.tid}`,
      category: 'thread',
      marks: rootMarks,
      measures: rootMeasures,
    }
  }

  // --- CPU-profile synthesis ---------------------------------------------

  /**
   * Stitch each JS-frame root from the CPU profile into the existing B/E/X
   * tree. `findDeepestContaining(start)` alone is not enough: the sampler
   * keeps running past the end of the innermost trace event (typical tail
   * is tens of µs of overshoot), so a blind attach produces a child whose
   * `end` extends past its parent. It also produces same-depth overlap
   * between the JS root and whatever V8 Console / Debugger slices the host
   * already holds — all of which should nest *inside* the JS function that
   * was on the call stack while they fired.
   *
   * The algorithm:
   *
   *   1. Pick the innermost existing Measure whose start-range covers
   *      `jsRoot.start`. This is the "anchor" depth at which JS was known
   *      to be running.
   *   2. Walk up from the anchor until an ancestor's bounds fully contain
   *      `[jsRoot.start, jsRoot.end]`. Use that as the host if found;
   *      otherwise fall back to the anchor and clip the JS subtree to its
   *      bounds.
   *   3. Clip any Measure in the JS subtree whose bounds escape the host.
   *      This trims sampler overshoot and keeps the parent-wider-than-
   *      children invariant every downstream consumer (mipmap builder,
   *      renderer, aggregator) expects.
   *   4. Re-parent any pre-existing host children whose bounds fall within
   *      the JS root's span under the JS root itself. Those siblings were
   *      logged while the JS function was on the stack; this reproduces the
   *      correct flame-chart nesting rather than treating them as peers.
   *
   * Runs once per JS root. Must be called before `finalizeContainer` so the
   * per-container `sort(compareByStart)` and `maxEnd` computation see the
   * final tree.
   */
  private _attachJsFramesForThread(
    proc: ProcessInfo,
    thread: ThreadInfo,
    rootMeasures: Measure[],
    toMs: (ts: number) => number,
  ): void {
    for (const profile of this._cpuProfiles.values()) {
      if (profile.pid !== proc.pid || profile.ownerTid !== thread.tid) continue
      if (profile.samples.length === 0) continue
      const jsRoots = this._buildJsFrameTree(profile, toMs)
      for (const jsRoot of jsRoots) {
        attachJsRoot(rootMeasures, jsRoot)
      }
    }
  }

  /**
   * Walks the profile's sample timeline and produces a tree of synthesized
   * `Measure`s where each Measure represents a run of consecutive samples
   * whose call stack agrees at that depth. Mirrors the stack-diff algorithm
   * DevTools uses in `CPUProfileDataModel.forEachFrame`.
   *
   * Returns the depth-0 roots; each has nested children at depth 1..N. The
   * returned Measures carry microsecond-domain `ts` values already mapped
   * to milliseconds via `toMs`.
   */
  private _buildJsFrameTree(
    profile: CpuProfile,
    toMs: (ts: number) => number,
  ): Measure[] {
    interface OpenJsFrame {
      node: CpuNode
      startTs: number
      children: Measure[]
    }
    interface SamplePoint {
      ts: number
      sampleId: number
      order: number
    }
    const openStack: OpenJsFrame[] = []
    const roots: Measure[] = []

    const closeFromDepth = (depth: number, ts: number): void => {
      while (openStack.length > depth) {
        const open = openStack.pop()!
        const endTs = ts > open.startTs ? ts : open.startTs
        const measure = this._makeJsFrameMeasure(open.node, open.startTs, endTs, open.children, toMs)
        if (openStack.length === 0) roots.push(measure)
        else openStack[openStack.length - 1].children.push(measure)
      }
    }

    // Some real-world V8 profiles contain negative `timeDeltas` corrections,
    // so the raw sample stream can arrive slightly out of timestamp order.
    // Feeding that directly into the stack-diff synthesizer can reopen the
    // same node before the earlier segment closes, yielding same-depth
    // overlaps, while naively clamping the clock forward erases earlier JS
    // spans altogether. Instead, accumulate absolute sample timestamps first,
    // then process the samples in stable time order.
    const samplePoints: SamplePoint[] = []
    let cumTs = profile.startTs
    for (let i = 0; i < profile.samples.length; i++) {
      cumTs += profile.timeDeltas[i] ?? 0
      samplePoints.push({ts: cumTs, sampleId: profile.samples[i], order: i})
    }
    samplePoints.sort((a, b) => a.ts - b.ts || a.order - b.order)

    for (const point of samplePoints) {
      const ts = point.ts
      const stack = buildCpuStack(profile.nodes, point.sampleId)

      if (isIdleStack(stack)) {
        closeFromDepth(0, ts)
        continue
      }

      let lcp = 0
      const limit = Math.min(openStack.length, stack.length)
      while (lcp < limit && openStack[lcp].node.id === stack[lcp].id) lcp++

      closeFromDepth(lcp, ts)

      for (let d = lcp; d < stack.length; d++) {
        openStack.push({node: stack[d], startTs: ts, children: []})
      }
    }

    // Close any still-open frames at the end of the profile.
    const endTs = samplePoints.length > 0 ? samplePoints[samplePoints.length - 1].ts : profile.startTs
    closeFromDepth(0, endTs)
    return roots
  }

  private _makeJsFrameMeasure(
    node: CpuNode,
    startTs: number,
    endTs: number,
    children: Measure[],
    toMs: (ts: number) => number,
  ): Measure {
    const cf: CpuCallFrame = node.callFrame ?? {functionName: ''}
    const label = cf.functionName || '(anonymous)'
    return {
      id: this._nextId(),
      name: label,
      start: toMs(startTs),
      end: toMs(endTs),
      category: JS_FRAME_CATEGORY,
      events: [],
      marks: [],
      measures: children,
      attribution: {
        kind: 'callsite',
        source: 'v8-cpu-profile',
        label,
        location: {
          url: cf.url,
          lineNumber: cf.lineNumber,
          columnNumber: cf.columnNumber,
        },
      },
    }
  }

  private _buildAsyncTrack(pid: number, toMs: (ts: number) => number): Track | null {
    const measures: Measure[] = []
    const marks: Mark[] = []

    for (const [key, pidForKey] of this._asyncPidByKey) {
      if (pidForKey !== pid) continue
      const events = this._asyncByKey.get(key)
      if (!events) continue
      const sorted = [...events].sort((a, b) => a.ts - b.ts)
      let open: ChromeEvent | undefined

      for (const ev of sorted) {
        if (ev.ph === 'b') {
          if (open) {
            // Back-to-back begins — close the previous one at this ts.
            measures.push(this._makeAsyncMeasure(open, ev.ts, null, toMs))
          }
          open = ev
        } else if (ev.ph === 'e') {
          if (open) {
            measures.push(this._makeAsyncMeasure(open, ev.ts, ev, toMs))
            open = undefined
          }
        } else if (ev.ph === 'n') {
          marks.push(this._makeMark(ev, toMs))
        }
      }

      if (open) {
        const endTs = Number.isFinite(this._maxTs) ? this._maxTs : open.ts
        measures.push(this._makeAsyncMeasure(open, endTs, null, toMs))
      }
    }

    if (measures.length === 0 && marks.length === 0) return null

    return {
      id: `trk-${pid}-async`,
      name: 'Async',
      category: 'async',
      marks,
      measures,
    }
  }

  private *_buildCounterTracks(pid: number, toMs: (ts: number) => number): Iterable<Track> {
    const prefix = `${pid}|`
    for (const [key, events] of this._countersByKey) {
      if (!key.startsWith(prefix)) continue
      if (events.length === 0) continue
      const counterName = events[0].name
      const sorted = [...events].sort((a, b) => a.ts - b.ts)
      const marks = sorted.map(ev => this._makeMark(ev, toMs))
      yield {
        id: `trk-${pid}-counter-${counterName}`,
        name: `Counter: ${counterName}`,
        category: 'counter',
        marks,
        measures: [],
      }
    }
  }

  /**
   * Build a Measure from a B/E or X frame. Historically stashed shallow
   * copies of the raw begin/end events on `Measure.events` — useful for
   * debug tooling but nothing in the UI reads it, and at 200M events
   * those copies dominate RAM. We now leave `events: []`; callers that
   * truly want the raw payload can re-parse from source.
   */
  private _makeMeasureFromFrame(
    frame: Frame,
    endTs: number,
    _endEvent: ChromeEvent | null,
    toMs: (ts: number) => number,
  ): Measure {
    const begin = frame.event
    const measure: Measure = {
      id: this._nextId(),
      name: begin.name,
      start: toMs(begin.ts),
      end: toMs(endTs),
      category: begin.cat,
      events: EMPTY_RAW_EVENTS,
      marks: frame.marks,
      measures: frame.children,
    }
    // Surface any online-merge record stashed during ingest as a
    // proper CompactionReport so UI code treats online + finalize
    // folds uniformly.
    const mergeRecord = extractOnlineMergeRecord(begin)
    if (mergeRecord) {
      measure.compaction = [
        {
          origin: 'sibling',
          category: begin.cat,
          names: [begin.name],
          count: mergeRecord.count,
          firstTs: toMs(mergeRecord.firstTs),
          lastTs: toMs(mergeRecord.lastTs),
          totalDurationMs: mergeRecord.totalDur / 1000,
        },
      ]
      this._compactionCounters.siblingRunsFolded += 1
      this._compactionCounters.siblingEventsFolded += mergeRecord.count
    }
    return measure
  }

  private _makeAsyncMeasure(
    begin: ChromeEvent,
    endTs: number,
    _endEvent: ChromeEvent | null,
    toMs: (ts: number) => number,
  ): Measure {
    return {
      id: this._nextId(),
      name: begin.name,
      start: toMs(begin.ts),
      end: toMs(endTs),
      category: begin.cat,
      events: EMPTY_RAW_EVENTS,
      marks: [],
      measures: [],
    }
  }

  private _makeMark(ev: ChromeEvent, toMs: (ts: number) => number): Mark {
    return {
      id: this._nextId(),
      name: ev.name,
      time: toMs(ev.ts),
      category: ev.cat,
      events: EMPTY_RAW_EVENTS,
    }
  }

  /**
   * Mint a short, URL-friendly id for a parsed Measure or Mark. Single
   * monotonically increasing global counter formatted as lowercase hex (no
   * prefix, no zero-padding). For typical traces (<1M events) ids stay
   * ≤ 5 characters, which keeps deep-link URLs short enough to paste into
   * bug reports without wrapping.
   */
  private _nextId(): string {
    this._idCounter += 1
    return this._idCounter.toString(16)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  throw reason ?? new DOMException('Aborted', 'AbortError')
}

function isChromeParserOptions(value: unknown): value is ChromeParserOptions {
  return typeof value === 'object' && value !== null
}

/**
 * Walk a sample's leaf node back to root, producing a root→leaf stack with
 * synthetic nodes (`(root)`) filtered out. Nodes whose parent pointer is
 * missing from the map act as roots themselves — benign for malformed
 * chunks.
 */
function buildCpuStack(nodes: Map<number, CpuNode>, leafId: number): CpuNode[] {
  const reversed: CpuNode[] = []
  let cursor: CpuNode | undefined = nodes.get(leafId)
  let guard = 0
  // The 1024 guard protects against a corrupt chunk that accidentally forms a
  // parent cycle — not a real shape, but cheap insurance against an infinite
  // loop on the main parse path.
  while (cursor && guard < 1024) {
    reversed.push(cursor)
    if (cursor.parent === undefined) break
    const parent: CpuNode | undefined = nodes.get(cursor.parent)
    if (!parent) break
    cursor = parent
    guard += 1
  }
  const out: CpuNode[] = []
  for (let i = reversed.length - 1; i >= 0; i--) {
    const node = reversed[i]
    const name = node.callFrame?.functionName ?? ''
    if (HIDDEN_CPU_NODE_NAMES.has(name)) continue
    out.push(node)
  }
  return out
}

/**
 * True when the remaining stack represents "V8 has no user JS running right
 * now" — either empty (root-only sample) or exactly one of the synthetic
 * `(program)` / `(idle)` pseudo-frames. DevTools treats these as gaps in the
 * JS flame chart; we do too, closing any open JS frames at the sample ts.
 */
function isIdleStack(stack: CpuNode[]): boolean {
  if (stack.length === 0) return true
  if (stack.length !== 1) return false
  const name = stack[0].callFrame?.functionName ?? ''
  return IDLE_CPU_NODE_NAMES.has(name)
}

/**
 * Linear-time search for the deepest existing Measure whose time range
 * covers `ts`, plus the chain of ancestors from root to that leaf. Used by
 * {@link attachJsRoot} so we can walk up from the deepest start-containing
 * Measure to find one whose bounds also cover the JS root's end.
 *
 * Measures at this point are unsorted (finalize happens later), so we do a
 * naive descent; the tree is shallow enough on real traces that the cost
 * is negligible next to parse.
 *
 * Returns the chain root → deepest. Empty array means no existing Measure
 * contains `ts` at all.
 */
function findAncestorChain(measures: Measure[], ts: number): Measure[] {
  for (const m of measures) {
    if (ts < m.start || ts > m.end) continue
    const deeper = findAncestorChain(m.measures, ts)
    if (deeper.length > 0) return [m, ...deeper]
    return [m]
  }
  return []
}

/**
 * Stitch `jsRoot` into `rootMeasures`, clipping its subtree and re-parenting
 * any pre-existing host children whose bounds fall within the JS root's
 * span. See {@link ChromeParser._attachJsFramesForThread} for the rationale.
 *
 * `parent` is `null` when the host is the track root; otherwise it's the
 * Measure whose `measures` array receives `jsRoot`.
 */
function attachJsRoot(rootMeasures: Measure[], jsRoot: Measure): void {
  const chain = findAncestorChain(rootMeasures, jsRoot.start)

  // Pick the innermost ancestor whose bounds also cover jsRoot.end. If
  // none does (sampler tail extends past every ancestor), fall back to the
  // deepest start-containing Measure and clip.
  let hostChildren: Measure[] = rootMeasures
  let hostEnd = Number.POSITIVE_INFINITY
  let hostStart = Number.NEGATIVE_INFINITY
  for (let i = chain.length - 1; i >= 0; i--) {
    const ancestor = chain[i]
    if (ancestor.end + JS_HOST_OVERSHOOT_EPSILON_MS >= jsRoot.end) {
      hostChildren = ancestor.measures
      hostEnd = ancestor.end
      hostStart = ancestor.start
      break
    }
    if (i === 0) {
      // No ancestor fully contains the JS root. Use the deepest
      // start-containing Measure as the host and clip.
      const deepest = chain[chain.length - 1]
      hostChildren = deepest.measures
      hostEnd = deepest.end
      hostStart = deepest.start
    }
  }

  // Clip the JS subtree's bounds so no descendant escapes the host. The
  // jsRoot itself gets clipped too in case of tail overshoot.
  clipSubtreeToBounds(jsRoot, hostStart, hostEnd)

  // Re-parent any pre-existing host children whose bounds overlap the
  // (clipped) JS root's span. Fully-contained siblings move wholesale;
  // straddlers get clipped to the overlapping interval first. This mirrors
  // the descendant-level straddler handling below: we would rather keep the
  // in-JS portion of a `V8Console` / `v8::Debugger::*` slice nested under the
  // JS frame than leave it as a same-depth peer that overlaps the user-code
  // bar we just attached.
  //
  // For each sibling, descend into the JS subtree and attach at the deepest
  // JS descendant whose bounds still contain it — otherwise a sibling that
  // fires inside (say) `flushPassiveEffects` ends up as a peer of
  // `flushPassiveEffects` rather than a child, reintroducing the same-depth
  // overlap we just fixed at the host level.
  const remaining: Measure[] = []
  const reparented: Measure[] = []
  for (const existing of hostChildren) {
    const overlapStart = existing.start > jsRoot.start ? existing.start : jsRoot.start
    const overlapEnd = existing.end < jsRoot.end ? existing.end : jsRoot.end
    if (overlapStart < overlapEnd) {
      if (existing.start < overlapStart) existing.start = overlapStart
      if (existing.end > overlapEnd) existing.end = overlapEnd
      clipSubtreeToBounds(existing, existing.start, existing.end)
      if (existing.start < existing.end) reparented.push(existing)
    } else {
      remaining.push(existing)
    }
  }
  for (const r of reparented) {
    attachUnderDeepestJsDescendant(jsRoot, r)
  }

  // Mutate in place: hostChildren is a live reference to either a
  // Measure.measures array or the track's rootMeasures.
  hostChildren.length = 0
  for (const r of remaining) hostChildren.push(r)
  hostChildren.push(jsRoot)
}

/**
 * Walk down `parent.measures` and attach `sibling` at the deepest JS
 * descendant whose bounds fully contain `sibling`'s bounds. This mirrors
 * the DevTools semantic where `v8::Debugger::*` / `V8Console::*` events
 * nest under whatever JS function was on the call stack when they fired.
 *
 * When no descendant fully contains the sibling (i.e. the sibling
 * straddles two JS sub-frames — e.g. the debugger hook started during
 * `fooA` but the sampler closed `fooA` and opened `fooB` mid-call), pick
 * the descendant with the largest time overlap, clip the sibling to that
 * descendant's bounds (plus clip the sibling's own subtree), and descend
 * into it. Straddling without clipping reintroduces same-depth overlap at
 * the parent level, which is exactly what broke the mint-vs-gray bleed in
 * the first place.
 */
function attachUnderDeepestJsDescendant(parent: Measure, sibling: Measure): void {
  for (const child of parent.measures) {
    if (sibling.start >= child.start && sibling.end <= child.end) {
      attachUnderDeepestJsDescendant(child, sibling)
      return
    }
  }
  let best: Measure | null = null
  let bestOverlap = 0
  for (const child of parent.measures) {
    const lo = Math.max(sibling.start, child.start)
    const hi = Math.min(sibling.end, child.end)
    const overlap = hi - lo
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = child
    }
  }
  if (best) {
    if (sibling.start < best.start) sibling.start = best.start
    if (sibling.end > best.end) sibling.end = best.end
    clipSubtreeToBounds(sibling, sibling.start, sibling.end)
    attachUnderDeepestJsDescendant(best, sibling)
    return
  }
  parent.measures.push(sibling)
}

/**
 * Recursively clip a Measure and every descendant so their bounds stay
 * within `[minStart, maxEnd]`. Clipping only narrows `start`/`end`; a
 * Measure whose bounds would collapse (start >= end after clipping) is
 * dropped from its parent. The clipping is parent-anchored, so children
 * that escape a freshly-clipped parent are re-clipped on the recursive
 * call.
 */
function clipSubtreeToBounds(m: Measure, minStart: number, maxEnd: number): void {
  if (m.start < minStart) m.start = minStart
  if (m.end > maxEnd) m.end = maxEnd
  if (m.measures.length === 0) return
  const kept: Measure[] = []
  for (const child of m.measures) {
    if (child.end <= m.start || child.start >= m.end) continue
    clipSubtreeToBounds(child, m.start, m.end)
    if (child.start < child.end) kept.push(child)
  }
  if (kept.length !== m.measures.length) {
    m.measures.length = 0
    for (const c of kept) m.measures.push(c)
  }
}

/**
 * Recursively sort a container's measures and marks by start time and compute
 * its `maxEnd` from its own measures' ends plus child subtrees. Viewer code
 * relies on the sort order for O(log n) horizontal culling and on `maxEnd`
 * to prune whole subtrees that fall outside the viewport.
 */
function finalizeContainer(container: TimelineContainer): number {
  let maxEnd = Number.NEGATIVE_INFINITY

  for (const measure of container.measures) {
    const childMax = finalizeContainer(measure)
    const end = measure.end > childMax ? measure.end : childMax
    if (end > maxEnd) maxEnd = end
  }

  for (const mark of container.marks) {
    if (mark.time > maxEnd) maxEnd = mark.time
  }

  container.measures.sort(compareByStart)
  container.marks.sort(compareMarkByTime)

  container.maxEnd = maxEnd === Number.NEGATIVE_INFINITY ? 0 : maxEnd
  return container.maxEnd
}

function compareByStart(a: Measure, b: Measure): number {
  if (a.start !== b.start) return a.start - b.start
  return b.end - a.end
}

function compareMarkByTime(a: Mark, b: Mark): number {
  return a.time - b.time
}

function compareProcesses(a: ProcessInfo, b: ProcessInfo): number {
  const aIdx = a.sortIndex ?? Number.POSITIVE_INFINITY
  const bIdx = b.sortIndex ?? Number.POSITIVE_INFINITY
  if (aIdx !== bIdx) return aIdx - bIdx
  return a.discoveryIndex - b.discoveryIndex
}

function compareThreads(a: ThreadInfo, b: ThreadInfo, discoveryOrder: number[]): number {
  const aIdx = a.sortIndex ?? Number.POSITIVE_INFINITY
  const bIdx = b.sortIndex ?? Number.POSITIVE_INFINITY
  if (aIdx !== bIdx) return aIdx - bIdx
  return discoveryOrder.indexOf(a.tid) - discoveryOrder.indexOf(b.tid)
}


/**
 * Sort events by `ts` ascending with parent-first tie-breaking so that
 * enclosing B/X events come before their children at the same timestamp.
 * Loosely mirrors Lighthouse's `filteredTraceSort`.
 */
function stableSortByTs(events: ChromeEvent[]): ChromeEvent[] {
  const indexed = events.map((ev, i) => ({ev, i}))
  indexed.sort((a, b) => {
    const dts = a.ev.ts - b.ev.ts
    if (dts !== 0) return dts
    const aIsE = a.ev.ph === 'E' ? 0 : 1
    const bIsE = b.ev.ph === 'E' ? 0 : 1
    if (aIsE !== bIsE) return aIsE - bIsE
    const aDur = typeof a.ev.dur === 'number' ? a.ev.dur : 0
    const bDur = typeof b.ev.dur === 'number' ? b.ev.dur : 0
    if (aDur !== bDur) return bDur - aDur
    return a.i - b.i
  })
  return indexed.map(x => x.ev)
}

