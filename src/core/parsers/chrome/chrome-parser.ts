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
import {yieldToEventLoop} from '../../utils/yieldToEventLoop'
import type {FinalizeOptions, TraceParser} from '../types'
import {
  asyncKey,
  counterKey,
  isAsyncPh,
  isComplete,
  isCounterPh,
  isDurationBegin,
  isDurationEnd,
  isInstantPh,
  isMetadataPh,
  type ChromeEvent,
} from './chrome-types'

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
 * Supported phases in this v1: B/E/X (durations), I/i/R (instants), M (metadata,
 * populates process/thread names), b/e/n (async), C (counter). Flows, samples,
 * object-lifetime, and clock-sync events are ignored for now.
 */
export class ChromeParser implements TraceParser {
  static readonly MAGIC_PATTERN: Uint8Array = MAGIC
  static readonly parserName = 'chrome'

  private readonly _json_parser: JSONParser
  private _error: Error | null = null
  private _rootMetadata: Record<string, unknown> = {}
  private _processes = new Map<number, ProcessInfo>()
  private _processDiscoveryCounter = 0
  private _asyncByKey = new Map<string, ChromeEvent[]>()
  private _asyncPidByKey = new Map<string, number>()
  private _countersByKey = new Map<string, ChromeEvent[]>()
  private _counterPidByKey = new Map<string, number>()
  private _eventCount = 0
  private _minTs = Number.POSITIVE_INFINITY
  private _maxTs = Number.NEGATIVE_INFINITY
  private _idCounter = 0

  constructor() {
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

    this._eventCount += 1

    if (isMetadataPh(ph)) {
      this._ingestMetadata(ev)
      return
    }

    if (typeof ev.ts === 'number' && Number.isFinite(ev.ts)) {
      if (ev.ts < this._minTs) this._minTs = ev.ts
      const end = ev.ts + (typeof ev.dur === 'number' ? ev.dur : 0)
      if (end > this._maxTs) this._maxTs = end
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

    return {
      id: `trk-${proc.pid}-${thread.tid}`,
      name: thread.name ?? `Thread ${thread.tid}`,
      category: 'thread',
      marks: rootMarks,
      measures: rootMeasures,
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
