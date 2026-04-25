/// <reference lib="webworker" />

import {parseTrace} from '../../core'
import type {WorkerMessage, WorkerRequest} from '../protocol'
import {collectParsedTraceTransferables, stripParsedTreeForTransfer} from '../transferables'

declare const self: DedicatedWorkerGlobalScope

let currentAbort: AbortController | null = null

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return

  if (msg.type === 'abort') {
    currentAbort?.abort(msg.reason ?? 'aborted')
    return
  }

  if (msg.type === 'parse') {
    void runParse(msg.stream, msg.source, msg.maxBytes)
  }
}

async function runParse(
  stream: ReadableStream<Uint8Array>,
  source: {name: string; size: number},
  maxBytes: number | undefined,
): Promise<void> {
  const abort = new AbortController()
  currentAbort = abort

  try {
    const trace = await parseTrace(stream, source, {
      signal: abort.signal,
      maxBytes,
      onProgress: progress => {
        post({type: 'progress', progress})
      },
    })
    // Transfer every typed-array backing buffer so the main thread
    // receives them in O(1) without a structured-clone copy. On a 1GB
    // trace this is a ~80-500 MB saving depending on mipmap depth.
    const transferList = collectParsedTraceTransferables(trace)
    // Then sever the recursive `Measure` tree. Without this, deep
    // CPU-profile traces blow V8's structured-clone stack with
    // "Maximum call stack size exceeded" before postMessage emits a
    // byte. The flat `buffers` SoA carries everything the main thread
    // actually reads.
    stripParsedTreeForTransfer(trace)
    self.postMessage({type: 'done', trace} as WorkerMessage, transferList)
  } catch (err) {
    const e = toErrorDescriptor(err)
    post({type: 'error', error: e})
  } finally {
    if (currentAbort === abort) currentAbort = null
  }
}

function post(msg: WorkerMessage): void {
  self.postMessage(msg)
}

function toErrorDescriptor(err: unknown): {name: string; message: string} {
  if (err instanceof Error) {
    return {name: err.name || 'Error', message: err.message}
  }
  if (err && typeof err === 'object' && 'name' in err && 'message' in err) {
    const e = err as {name?: unknown; message?: unknown}
    return {
      name: typeof e.name === 'string' ? e.name : 'Error',
      message: typeof e.message === 'string' ? e.message : String(err),
    }
  }
  return {name: 'Error', message: String(err)}
}
