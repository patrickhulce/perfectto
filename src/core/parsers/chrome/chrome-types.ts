/**
 * Internal chrome-parser types. Not exported from the package root.
 *
 * Shape follows the Trace Event Format spec:
 * https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU
 */

export interface ChromeEvent {
  ph: string
  name: string
  cat?: string
  pid: number
  tid: number
  ts: number
  dur?: number
  tdur?: number
  tts?: number
  id?: string | number
  id2?: {local?: string; global?: string}
  scope?: string
  args?: Record<string, unknown>
  s?: string
  [key: string]: unknown
}

export const DURATION_BEGIN = 'B'
export const DURATION_END = 'E'
export const COMPLETE = 'X'
export const INSTANT = 'I'
export const INSTANT_LEGACY_LOWER = 'i'
export const MARK = 'R'
export const METADATA = 'M'
export const ASYNC_BEGIN = 'b'
export const ASYNC_END = 'e'
export const ASYNC_INSTANT = 'n'
export const COUNTER = 'C'
export const SAMPLE = 'P'

/**
 * Options accepted by {@link ChromeParser}. Defaults are chosen to match what
 * Chrome DevTools shows out of the box — callers who want the raw trace tree
 * (the "raw" persona, a debugging tool, …) can flip these off.
 */
export interface ChromeParserOptions {
  /**
   * When true (default), drop events whose name starts with `V8.GC_` during
   * ingest so `MinorGC` / `V8.GCScavenger` render as single leaves instead of
   * towers of internal GC phase slices. DevTools hides these by default.
   */
  collapseGcInternals?: boolean
}

/**
 * V8 CPU-profile call-frame node as shipped inside a `ProfileChunk`'s
 * `args.data.cpuProfile.nodes[]`. Nodes arrive in delta batches; we accumulate
 * them in a `Map<id, CpuNode>` keyed by id and follow `parent` at synthesis
 * time to reconstruct stacks.
 */
export interface CpuNode {
  id: number
  parent?: number
  callFrame: CpuCallFrame
}

export interface CpuCallFrame {
  functionName: string
  url?: string
  scriptId?: number | string
  lineNumber?: number
  columnNumber?: number
  codeType?: string
}

/**
 * Accumulated state for one V8 CPU profile (`Profile` + all its `ProfileChunk`s).
 * DevTools associates samples with the thread the `Profile` event was emitted on
 * (the owning main thread), not the profiler thread the chunks arrive on.
 */
export interface CpuProfile {
  key: string
  pid: number
  ownerTid: number
  startTs: number
  nodes: Map<number, CpuNode>
  samples: number[]
  timeDeltas: number[]
}

export function isSamplePh(ph: string): boolean {
  return ph === SAMPLE
}

export function cpuProfileKey(pid: number, id: unknown): string {
  const raw = typeof id === 'string' || typeof id === 'number' ? String(id) : '0x1'
  return `${pid}|${raw}`
}

export function isDurationBegin(ph: string): boolean {
  return ph === DURATION_BEGIN
}

export function isDurationEnd(ph: string): boolean {
  return ph === DURATION_END
}

export function isComplete(ph: string): boolean {
  return ph === COMPLETE
}

export function isDurationPh(ph: string): boolean {
  return ph === DURATION_BEGIN || ph === DURATION_END || ph === COMPLETE
}

export function isInstantPh(ph: string): boolean {
  return ph === INSTANT || ph === INSTANT_LEGACY_LOWER || ph === MARK
}

export function isAsyncPh(ph: string): boolean {
  return ph === ASYNC_BEGIN || ph === ASYNC_END || ph === ASYNC_INSTANT
}

export function isCounterPh(ph: string): boolean {
  return ph === COUNTER
}

export function isMetadataPh(ph: string): boolean {
  return ph === METADATA
}

export function tidKey(pid: number, tid: number): string {
  return `${pid}:${tid}`
}

export function asyncKey(ev: ChromeEvent): string {
  const scope = ev.scope ?? ''
  const cat = ev.cat ?? ''
  if (ev.id2?.local !== undefined) {
    return `local|${ev.pid}|${cat}|${scope}|${ev.id2.local}`
  }
  if (ev.id2?.global !== undefined) {
    return `global|${cat}|${scope}|${ev.id2.global}`
  }
  return `id|${cat}|${scope}|${ev.id ?? ''}`
}

export function counterKey(ev: ChromeEvent): string {
  return `${ev.pid}|${ev.name}`
}
