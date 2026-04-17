export type RawEvent = Record<string, unknown>

export interface TimelineContainer {
  marks: Mark[]
  measures: Measure[]
}

export interface Mark {
  id: string
  name: string
  time: number
  category?: string
  color?: string
  events: RawEvent[]
}

export interface Measure extends TimelineContainer {
  id: string
  name: string
  start: number
  end: number
  category?: string
  color?: string
  events: RawEvent[]
  compaction?: CompactionReport[]
}

export interface CompactionReport {
  category: string
  names: string[]
  fraction: number
  events: RawEvent[]
}

export interface Track extends TimelineContainer {
  id: string
  name: string
  category?: string
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
  events: Array<Mark | Measure>
}

export type TraceInput =
  | ReadableStream<Uint8Array>
  | AsyncIterable<ReadableStream<Uint8Array>>

export interface ParseProgress {
  streamIndex: number
  bytesRead: number
  phase: 'parsing' | 'done'
}

export interface ParseOptions {
  signal?: AbortSignal
  onProgress?: (progress: ParseProgress) => void
}
