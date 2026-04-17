import type {
  Mark,
  Measure,
  ParseOptions,
  ParseProgress,
  ParsedTrace,
  TimelineContainer,
  TraceInput,
  TraceSource,
} from './types'

const THROTTLE_BYTES = 64 * 1024
const THROTTLE_MS = 50

export async function parseTrace(
  input: TraceInput,
  source: TraceSource,
  options?: ParseOptions,
): Promise<ParsedTrace> {
  const { signal, onProgress } = options ?? {}

  throwIfAborted(signal)

  let bytesRead = 0
  let streamIndex = 0
  let lastEmitBytes = 0
  let lastEmitTime = 0

  const emit = (phase: ParseProgress['phase'], force: boolean) => {
    if (!onProgress) return
    const now = Date.now()
    if (
      !force &&
      bytesRead - lastEmitBytes < THROTTLE_BYTES &&
      now - lastEmitTime < THROTTLE_MS
    ) {
      return
    }
    lastEmitBytes = bytesRead
    lastEmitTime = now
    onProgress({ streamIndex, bytesRead, phase })
  }

  for await (const stream of normalizeInput(input)) {
    throwIfAborted(signal)
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    const cancelOnAbort = () => {
      reader.cancel(abortReason(signal)).catch(() => {})
    }
    signal?.addEventListener('abort', cancelOnAbort)
    try {
      while (true) {
        throwIfAborted(signal)
        const { value, done } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) {
          bytesRead += value.byteLength
          // Decoded text is currently discarded; the dummy parser ignores it.
          // Keeping the decoder lets the real parser slot in without churn.
          decoder.decode(value, { stream: true })
          emit('parsing', false)
        }
      }
      decoder.decode()
    } finally {
      signal?.removeEventListener('abort', cancelOnAbort)
      try {
        reader.releaseLock()
      } catch {
        // reader was already released via cancel()
      }
    }
    throwIfAborted(signal)
    // Force an emit at the boundary so consumers see each streamIndex at least once.
    emit('parsing', true)
    streamIndex += 1
  }

  emit('done', true)

  return buildDummyTrace(source)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal | undefined): unknown {
  const reason = signal?.reason
  if (reason !== undefined && reason !== null) return reason
  return new DOMException('Aborted', 'AbortError')
}

async function* normalizeInput(
  input: TraceInput,
): AsyncIterable<ReadableStream<Uint8Array>> {
  if (isReadableStream(input)) {
    yield input
    return
  }
  for await (const stream of input) {
    yield stream
  }
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream
}

function buildDummyTrace(source: TraceSource): ParsedTrace {
  const appRender: Measure = {
    id: 'm-app-render',
    name: 'App render',
    start: 10,
    end: 120,
    category: 'render',
    color: '#667eea',
    events: [{ phase: 'B', ts: 10 }, { phase: 'E', ts: 120 }],
    marks: [
      {
        id: 'mk-commit',
        name: 'Commit',
        time: 115,
        category: 'render',
        events: [{ phase: 'i', ts: 115 }],
      },
    ],
    measures: [
      {
        id: 'm-layout',
        name: 'Layout',
        start: 30,
        end: 80,
        category: 'render',
        color: '#7f9cf5',
        events: [{ phase: 'B', ts: 30 }, { phase: 'E', ts: 80 }],
        marks: [],
        measures: [],
      },
    ],
  }

  const paint: Measure = {
    id: 'm-paint',
    name: 'Paint',
    start: 125,
    end: 180,
    category: 'render',
    color: '#764ba2',
    events: [{ phase: 'B', ts: 125 }, { phase: 'E', ts: 180 }],
    marks: [],
    measures: [],
  }

  const firstInput: Mark = {
    id: 'mk-first-input',
    name: 'First input',
    time: 200,
    category: 'input',
    color: '#ed8936',
    events: [{ phase: 'i', ts: 200 }],
  }

  const fetchUsers: Measure = {
    id: 'm-fetch-users',
    name: 'GET /users',
    start: 50,
    end: 240,
    category: 'network',
    color: '#38b2ac',
    events: [{ phase: 'B', ts: 50 }, { phase: 'E', ts: 240 }],
    marks: [],
    measures: [],
  }

  const parseJson: Measure = {
    id: 'm-parse-json',
    name: 'Parse JSON',
    start: 240,
    end: 260,
    category: 'network',
    color: '#4fd1c5',
    events: [{ phase: 'B', ts: 240 }, { phase: 'E', ts: 260 }],
    marks: [],
    measures: [],
  }

  const timeline = {
    start: 0,
    end: 300,
    systems: [
      {
        id: 'sys-browser',
        name: 'Browser',
        tracks: [
          {
            id: 'trk-main',
            name: 'Main thread',
            category: 'cpu',
            marks: [firstInput],
            measures: [appRender, paint],
          },
          {
            id: 'trk-compositor',
            name: 'Compositor',
            category: 'cpu',
            marks: [],
            measures: [],
          },
        ],
      },
      {
        id: 'sys-network',
        name: 'Network',
        tracks: [
          {
            id: 'trk-http',
            name: 'HTTP',
            category: 'network',
            marks: [],
            measures: [fetchUsers, parseJson],
          },
        ],
      },
    ],
  }

  const events = collectEvents(timeline.systems.flatMap((s) => s.tracks))

  return {
    source,
    metadata: {
      tool: 'perfectto',
      parser: 'dummy',
      generatedAt: new Date(0).toISOString(),
    },
    timeline,
    events,
  }
}

function collectEvents(containers: TimelineContainer[]): Array<Mark | Measure> {
  const out: Array<Mark | Measure> = []
  for (const container of containers) {
    for (const mark of container.marks) {
      out.push(mark)
    }
    for (const measure of container.measures) {
      out.push(measure)
      out.push(...collectEvents([measure]))
    }
  }
  return out
}
