/// <reference lib="webworker" />

import {parseTrace} from '../../core'
import type {WorkerMessage, WorkerRequest} from '../protocol'

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
    void runParse(msg.stream, msg.source)
  }
}

async function runParse(
  stream: ReadableStream<Uint8Array>,
  source: {name: string; size: number},
): Promise<void> {
  const abort = new AbortController()
  currentAbort = abort

  try {
    const trace = await parseTrace(stream, source, {
      signal: abort.signal,
      onProgress: progress => {
        post({type: 'progress', progress})
      },
    })
    post({type: 'done', trace})
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
