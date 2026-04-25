import {parseTrace} from '../core'
import type {ParseOptions, ParsedTrace, TraceInput, TraceSource} from '../core'

import type {WorkerMessage} from './protocol'

/**
 * Same signature as {@link parseTrace}, but runs the parser in a dedicated
 * Web Worker so the main thread stays responsive. Falls back to an in-thread
 * parse if workers aren't available or the input can't be transferred (e.g.
 * an AsyncIterable of streams).
 */
export async function parseTraceInWorker(
  input: TraceInput,
  source: TraceSource,
  options?: ParseOptions,
): Promise<ParsedTrace> {
  const {signal, onProgress} = options ?? {}

  if (typeof Worker === 'undefined' || !isReadableStream(input)) {
    return parseTrace(input, source, options)
  }

  const worker = new Worker(new URL('./worker/trace-worker.ts', import.meta.url), {
    type: 'module',
  })

  return new Promise<ParsedTrace>((resolve, reject) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      fn()
    }

    const onAbort = (): void => {
      worker.postMessage({type: 'abort', reason: String(signal?.reason ?? 'aborted')})
      settle(() => reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')))
    }

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
    }

    worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
      const msg = ev.data
      if (!msg || typeof msg !== 'object') return
      switch (msg.type) {
        case 'progress':
          onProgress?.(msg.progress)
          break
        case 'done':
          settle(() => resolve(msg.trace))
          break
        case 'error': {
          const err = new Error(msg.error.message)
          err.name = msg.error.name
          settle(() => reject(err))
          break
        }
      }
    }

    worker.onerror = err => {
      // Without this, a worker crash (OOM, parse bug, uncaught async
      // rejection) surfaces as a bare `ErrorEvent` whose fields were
      // lost to structured-clone. Reconstruct a proper Error with the
      // `message`/`filename`/`lineno` so React's error boundary can
      // render something actionable.
      const fallback =
        err.message ||
        (err.filename ? `Worker error at ${err.filename}:${err.lineno}` : 'Worker error')
      const wrapped = err.error instanceof Error ? err.error : new Error(fallback)
      if (!wrapped.name) wrapped.name = 'WorkerError'
      settle(() => reject(wrapped))
    }

    worker.onmessageerror = ev => {
      settle(() =>
        reject(new Error(`Worker message deserialization failed${ev.data ? `: ${String(ev.data)}` : ''}`)),
      )
    }

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort)
    }

    try {
      worker.postMessage({type: 'parse', stream: input, source}, [
        input as unknown as Transferable,
      ])
    } catch (err) {
      settle(() => reject(err))
    }
  })
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream
}
