import type {ParseProgress, ParsedTrace, TraceSource} from '../core'

export interface WorkerParseRequest {
  type: 'parse'
  stream: ReadableStream<Uint8Array>
  source: TraceSource
  /**
   * Optional soft byte cap. Forwarded into `parseTrace`'s `maxBytes`
   * so the worker stops reading after roughly this many decompressed
   * bytes and finalizes on the partial input. Undefined / non-finite
   * means unlimited.
   */
  maxBytes?: number
}

export interface WorkerAbortRequest {
  type: 'abort'
  reason?: string
}

export type WorkerRequest = WorkerParseRequest | WorkerAbortRequest

export interface WorkerProgressMessage {
  type: 'progress'
  progress: ParseProgress
}

export interface WorkerDoneMessage {
  type: 'done'
  trace: ParsedTrace
}

export interface WorkerErrorMessage {
  type: 'error'
  error: {name: string; message: string}
}

export type WorkerMessage = WorkerProgressMessage | WorkerDoneMessage | WorkerErrorMessage
