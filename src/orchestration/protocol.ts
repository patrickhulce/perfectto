import type {ParseProgress, ParsedTrace, TraceSource} from '../core'

export interface WorkerParseRequest {
  type: 'parse'
  stream: ReadableStream<Uint8Array>
  source: TraceSource
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
