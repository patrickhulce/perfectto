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
const JS_FRAME_TRACE_CATEGORY = 'disabled-by-default-v8.cpu_profiler'

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

  constructor(options?: unknown) {
    const opts = isChromeParserOptions(options) ? options : {}
    this._options = {
      collapseGcInternals: opts.collapseGcInternals ?? true,
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
    if (this._error) throw this._error
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
      thread.events.push(ev)
    }
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

    for (const proc of processes) {
      throwIfAborted(signal)
      // Yield before each process so the host event loop stays live even if we
      // end up on a trace with one monstrous process.
      await yieldToEventLoop()
      if (onProgress) {
        onProgress({streamIndex, bytesRead: baseBytesRead, phase: 'finalizing'})
      }

      const tracks: Track[] = []

      const threads = [...proc.threads.values()].sort((a, b) =>
        compareThreads(a, b, proc.threadOrder),
      )
      for (const thread of threads) {
        if (thread.events.length === 0) continue
        tracks.push(this._buildThreadTrack(proc, thread, toMs))
      }

      const asyncTrack = this._buildAsyncTrack(proc.pid, toMs)
      if (asyncTrack) tracks.push(asyncTrack)

      for (const counterTrack of this._buildCounterTracks(proc.pid, toMs)) {
        tracks.push(counterTrack)
      }

      if (tracks.length === 0) continue

      for (const track of tracks) {
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
      }

      systems.push({
        id: `sys-${proc.pid}`,
        name: proc.name ?? `Process ${proc.pid}`,
        tracks,
      })
    }

    const timeline = {
      start: 0,
      end: Number.isFinite(this._minTs) && Number.isFinite(this._maxTs) ? toMs(this._maxTs) : 0,
      systems,
    }

    const events = collectEvents(timeline.systems.flatMap(s => s.tracks))

    const metadata: TraceMetadata = {
      ...this._rootMetadata,
      parser: 'chrome',
      eventCount: this._eventCount,
    }

    return {source, metadata, timeline, events}
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
        const host = findDeepestContaining(rootMeasures, jsRoot.start)
        if (host) host.measures.push(jsRoot)
        else rootMeasures.push(jsRoot)
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

    let cumTs = profile.startTs
    for (let i = 0; i < profile.samples.length; i++) {
      cumTs += profile.timeDeltas[i] ?? 0
      const ts = cumTs
      const stack = buildCpuStack(profile.nodes, profile.samples[i])

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
    const endTs = cumTs
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
    const rawEvent: RawEvent = {
      ph: 'JS_FRAME',
      cat: JS_FRAME_TRACE_CATEGORY,
      name: cf.functionName,
      ts: startTs,
      dur: endTs - startTs,
      functionName: cf.functionName,
      url: cf.url,
      scriptId: cf.scriptId,
      lineNumber: cf.lineNumber,
      columnNumber: cf.columnNumber,
      nodeId: node.id,
    }
    return {
      id: this._nextId('js'),
      name: cf.functionName || '(anonymous)',
      start: toMs(startTs),
      end: toMs(endTs),
      category: JS_FRAME_CATEGORY,
      events: [rawEvent],
      marks: [],
      measures: children,
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

  private _makeMeasureFromFrame(
    frame: Frame,
    endTs: number,
    endEvent: ChromeEvent | null,
    toMs: (ts: number) => number,
  ): Measure {
    const begin = frame.event
    const events: RawEvent[] = [toRawEvent(begin)]
    if (endEvent) events.push(toRawEvent(endEvent))
    return {
      id: this._nextId('m'),
      name: begin.name,
      start: toMs(begin.ts),
      end: toMs(endTs),
      category: begin.cat,
      events,
      marks: frame.marks,
      measures: frame.children,
    }
  }

  private _makeAsyncMeasure(
    begin: ChromeEvent,
    endTs: number,
    endEvent: ChromeEvent | null,
    toMs: (ts: number) => number,
  ): Measure {
    const events: RawEvent[] = [toRawEvent(begin)]
    if (endEvent) events.push(toRawEvent(endEvent))
    return {
      id: this._nextId('m-async'),
      name: begin.name,
      start: toMs(begin.ts),
      end: toMs(endTs),
      category: begin.cat,
      events,
      marks: [],
      measures: [],
    }
  }

  private _makeMark(ev: ChromeEvent, toMs: (ts: number) => number): Mark {
    return {
      id: this._nextId('mk'),
      name: ev.name,
      time: toMs(ev.ts),
      category: ev.cat,
      events: [toRawEvent(ev)],
    }
  }

  private _nextId(prefix: string): string {
    this._idCounter += 1
    return `${prefix}-${this._idCounter}`
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
 * covers `ts`. Used to pick the X-slice a synthesized JS-frame subtree
 * should attach under. Measures at this point are unsorted (finalize
 * happens later), so we do a naive descent; the tree is shallow enough on
 * real traces that the cost is negligible next to parse.
 */
function findDeepestContaining(measures: Measure[], ts: number): Measure | null {
  for (const m of measures) {
    if (ts < m.start || ts > m.end) continue
    const deeper = findDeepestContaining(m.measures, ts)
    return deeper ?? m
  }
  return null
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

function toRawEvent(ev: ChromeEvent): RawEvent {
  return {...ev}
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

function collectEvents(containers: TimelineContainer[]): Array<Mark | Measure> {
  const out: Array<Mark | Measure> = []
  for (const container of containers) {
    for (const mark of container.marks) out.push(mark)
    for (const measure of container.measures) {
      out.push(measure)
      out.push(...collectEvents([measure]))
    }
  }
  return out
}
