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
  phase: 'parsing' | 'finalizing' | 'done'
}

export interface ParseOptions {
  signal?: AbortSignal
  onProgress?: (progress: ParseProgress) => void
}
