/**
 * Streaming synthetic Chrome Trace Event Format generator.
 *
 * Emits a valid JSON object whose `traceEvents` array is written element-
 * by-element so callers can stress the streaming parser with multi-GB
 * payloads without ever materializing the full JSON string in memory.
 * Every helper below yields `Uint8Array` chunks; nothing returns a single
 * giant string.
 *
 * Used by:
 *   - src/__tests__/parserGenerated.test.ts (regression + bounded-memory
 *     asserts for compaction / deep nesting / sampler explosions).
 *   - scripts/smoke-canvas.ts (`--synthetic=<size>` end-to-end perf gate).
 */

export interface SyntheticTraceOpts {
  /** Total `X` (complete) events across all threads. */
  eventCount?: number
  /** Number of (pid,tid) pairs to spread events across. */
  threadCount?: number
  /** Maximum nesting depth of the synthesized B/E tree (used when `shape === 'nested'`). */
  maxDepth?: number
  /** Number of V8 CPU profile samples to emit (0 disables CPU profile). */
  jsSampleCount?: number
  /** Number of distinct CPU-profile node ids (1 function per id). */
  cpuNodeCount?: number
  /**
   * Length of a contiguous run of identical-(name,cat) sibling events.
   * Drops a run of this many events into one thread so the finalize
   * sibling compactor has an obvious target. 0 disables the run.
   */
  sameNameRunLength?: number
  /** Number of async begin/end pairs to emit. */
  asyncKeyCount?: number
  /**
   * Structural shape of the main per-thread event stream.
   *
   *   - 'flat':    every X is a sibling, uniformly spaced.
   *   - 'nested':  repeatedly pushes depth until `maxDepth`, then unwinds.
   *   - 'stairs':  alternates between wide-parent + sub-ms children so
   *                the CPU-profile-style micro-run compactor has work.
   */
  shape?: 'flat' | 'nested' | 'stairs'
  /**
   * Nanoseconds per event (ts step). Smaller values produce denser traces
   * that cross the compactor's sub-pixel threshold more often. Default
   * 10 µs gives a realistic event cadence.
   */
  tsStepUs?: number
  /**
   * Event-name template. `{i}` is replaced by the event index. Repeat the
   * same template across a run to force compaction; include `{i}` to force
   * uniqueness.
   */
  nameTemplate?: string
  /** Optional fixed category for every X event. */
  category?: string
}

export interface SyntheticTraceManifest {
  /** Total bytes emitted by the stream (post-UTF-8 encoding). */
  byteLength: number
  /** Count of every event the parser will see (X + metadata + async + sample). */
  totalEvents: number
  /** Count of X (complete) events only — excludes metadata/async/sample. */
  xEventCount: number
  /** Number of unique thread records encoded. */
  threadCount: number
  /** Max nesting depth the generator produced. */
  maxDepth: number
  /** Number of V8 sample ticks encoded. */
  jsSampleCount: number
  /** Number of async begin/end pairs encoded. */
  asyncKeyCount: number
  /** If a same-name run was included, its contiguous length; 0 otherwise. */
  sameNameRunLength: number
}

interface GenerateResult {
  stream: ReadableStream<Uint8Array>
  manifest: SyntheticTraceManifest
}

const ENCODER = new TextEncoder()
const CHUNK_FLUSH_THRESHOLD_BYTES = 64 * 1024

/**
 * Build a streaming synthetic trace. The stream is lazy: chunks are
 * generated on each `pull` so even a 10GB trace stays flat-memory on the
 * producer side. The returned `manifest` reports exact byte length + event
 * counts so tests can compare against what the parser observes.
 */
export function streamSyntheticTrace(opts: SyntheticTraceOpts = {}): GenerateResult {
  const cfg = normalizeOpts(opts)
  const manifest: SyntheticTraceManifest = {
    byteLength: 0,
    totalEvents: 0,
    xEventCount: 0,
    threadCount: cfg.threadCount,
    maxDepth: 0,
    jsSampleCount: cfg.jsSampleCount,
    asyncKeyCount: cfg.asyncKeyCount,
    sameNameRunLength: cfg.sameNameRunLength,
  }

  const gen = eventIterator(cfg, manifest)
  let generatorDone = false

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (generatorDone) {
        controller.close()
        return
      }
      // Drain the next batch until we've buffered a pull-sized chunk.
      // Batching amortizes the TextEncoder + enqueue cost across many
      // events; the parser is stream-aware and reads a raw byte buffer
      // anyway.
      let buf = ''
      while (buf.length < CHUNK_FLUSH_THRESHOLD_BYTES) {
        const next = gen.next()
        if (next.done) {
          generatorDone = true
          break
        }
        buf += next.value
      }
      if (buf.length > 0) {
        const bytes = ENCODER.encode(buf)
        manifest.byteLength += bytes.byteLength
        controller.enqueue(bytes)
      }
      if (generatorDone) controller.close()
    },
  })

  return {stream, manifest}
}

/**
 * Collect a stream into a single `Uint8Array`. Only used by tests that
 * need the raw bytes for multi-chunk replay; production callers should
 * feed the stream straight into `parseTrace` and never materialize it.
 */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  while (true) {
    const {value, done} = await reader.read()
    if (done) break
    if (!value) continue
    parts.push(value)
    total += value.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/**
 * Narrow the optional opts bag into a fully-populated config so the inner
 * iterator never has to branch on `undefined`.
 */
interface NormalizedOpts {
  eventCount: number
  threadCount: number
  maxDepth: number
  jsSampleCount: number
  cpuNodeCount: number
  sameNameRunLength: number
  asyncKeyCount: number
  shape: 'flat' | 'nested' | 'stairs'
  tsStepUs: number
  nameTemplate: string
  category: string
}

function normalizeOpts(opts: SyntheticTraceOpts): NormalizedOpts {
  return {
    eventCount: opts.eventCount ?? 1000,
    threadCount: Math.max(1, opts.threadCount ?? 1),
    maxDepth: Math.max(1, opts.maxDepth ?? 4),
    jsSampleCount: Math.max(0, opts.jsSampleCount ?? 0),
    cpuNodeCount: Math.max(2, opts.cpuNodeCount ?? 8),
    sameNameRunLength: Math.max(0, opts.sameNameRunLength ?? 0),
    asyncKeyCount: Math.max(0, opts.asyncKeyCount ?? 0),
    shape: opts.shape ?? 'flat',
    tsStepUs: Math.max(1, opts.tsStepUs ?? 10),
    nameTemplate: opts.nameTemplate ?? 'evt{i}',
    category: opts.category ?? 'synth',
  }
}

/**
 * Iterator over the JSON text of the trace. Yields chunks small enough
 * that the outer pull loop can aggregate them cheaply, but large enough
 * (a whole event record at a time) to keep TextEncoder overhead down.
 */
function* eventIterator(
  cfg: NormalizedOpts,
  manifest: SyntheticTraceManifest,
): Generator<string, void, void> {
  yield '{"metadata":{"source":"perfectto-synthetic"},"traceEvents":['
  let first = true
  const emit = (obj: Record<string, unknown>): string => {
    const prefix = first ? '' : ','
    first = false
    manifest.totalEvents += 1
    return prefix + JSON.stringify(obj)
  }

  // Stable per-thread metadata so the parser produces named systems/tracks.
  for (let t = 0; t < cfg.threadCount; t++) {
    const pid = 1000 + t
    const tid = 1
    yield emit({
      ph: 'M',
      name: 'process_name',
      cat: '__metadata',
      pid,
      tid,
      ts: 0,
      args: {name: `SyntheticProcess_${t}`},
    })
    yield emit({
      ph: 'M',
      name: 'thread_name',
      cat: '__metadata',
      pid,
      tid,
      ts: 0,
      args: {name: `SyntheticThread_${t}`},
    })
  }

  // Main X-event stream. Spread across threads round-robin so each thread
  // sees roughly `eventCount / threadCount` events.
  let ts = 0
  const step = cfg.tsStepUs
  const perThread = Math.ceil(cfg.eventCount / cfg.threadCount)
  let emittedX = 0

  // If a same-name run is requested, dedicate it to thread 0 and emit it
  // first so the finalize sibling compactor sees an obvious contiguous
  // run of identical (name,cat) siblings.
  if (cfg.sameNameRunLength > 0) {
    const pid = 1000
    const tid = 1
    for (let i = 0; i < cfg.sameNameRunLength && emittedX < cfg.eventCount; i++) {
      yield emit({
        ph: 'X',
        name: 'RunEvent',
        cat: cfg.category,
        pid,
        tid,
        ts,
        dur: step / 2,
      })
      ts += step
      emittedX += 1
      manifest.xEventCount += 1
    }
  }

  for (let t = 0; t < cfg.threadCount; t++) {
    const pid = 1000 + t
    const tid = 1
    const threadEvents =
      t === 0 ? Math.max(0, perThread - cfg.sameNameRunLength) : perThread
    if (threadEvents <= 0) continue
    const threadBaseTs = ts
    if (cfg.shape === 'flat') {
      for (let i = 0; i < threadEvents && emittedX < cfg.eventCount; i++) {
        yield emit({
          ph: 'X',
          name: cfg.nameTemplate.replace('{i}', String(i)),
          cat: cfg.category,
          pid,
          tid,
          ts: threadBaseTs + i * step,
          dur: step - 1,
        })
        emittedX += 1
        manifest.xEventCount += 1
      }
      ts = threadBaseTs + threadEvents * step
    } else if (cfg.shape === 'nested') {
      yield* nestedShape(cfg, manifest, pid, tid, threadBaseTs, threadEvents, emit, refs => {
        emittedX = refs.emittedX
        ts = refs.ts
      })
    } else {
      yield* stairsShape(cfg, manifest, pid, tid, threadBaseTs, threadEvents, emit, refs => {
        emittedX = refs.emittedX
        ts = refs.ts
      })
    }
  }

  // Async pairs anchored at thread 0 after the main stream.
  for (let a = 0; a < cfg.asyncKeyCount; a++) {
    const pid = 1000
    const tid = 1
    const asyncId = `async${a}`
    yield emit({
      ph: 'b',
      name: 'asyncOp',
      cat: cfg.category,
      pid,
      tid,
      ts,
      id: asyncId,
      scope: cfg.category,
    })
    yield emit({
      ph: 'e',
      name: 'asyncOp',
      cat: cfg.category,
      pid,
      tid,
      ts: ts + step * 4,
      id: asyncId,
      scope: cfg.category,
    })
    ts += step * 4
  }

  // CPU profile: a single `Profile` opener on thread 0 followed by a
  // `ProfileChunk` that carries the whole node tree and delta-encoded
  // samples. Shape is `(root) → program → fn0..fnN` — a real sampler
  // explosion pattern so the tiny-frame compactor has targets.
  if (cfg.jsSampleCount > 0) {
    yield* cpuProfile(cfg, emit)
    manifest.jsSampleCount = cfg.jsSampleCount
  }

  yield ']}'
}

function* nestedShape(
  cfg: NormalizedOpts,
  manifest: SyntheticTraceManifest,
  pid: number,
  tid: number,
  baseTs: number,
  count: number,
  emit: (obj: Record<string, unknown>) => string,
  report: (refs: {emittedX: number; ts: number}) => void,
): Generator<string, void, void> {
  // Repeatedly emit outer-then-inner X events up to `maxDepth` then unwind.
  // Each level's outer event covers `maxDepth*2*step` µs and each inner
  // leaf is `step` µs wide.
  const depth = Math.min(cfg.maxDepth, count)
  manifest.maxDepth = Math.max(manifest.maxDepth, depth)
  let emitted = 0
  let ts = baseTs
  const outerDur = depth * 2 * cfg.tsStepUs
  while (emitted < count) {
    const chunkStart = ts
    for (let d = 0; d < depth && emitted < count; d++) {
      const remainingDur = outerDur - d * 2 * cfg.tsStepUs
      yield emit({
        ph: 'X',
        name: `nest${d}`,
        cat: cfg.category,
        pid,
        tid,
        ts: chunkStart + d * cfg.tsStepUs,
        dur: Math.max(1, remainingDur),
      })
      emitted += 1
      manifest.xEventCount += 1
    }
    ts = chunkStart + outerDur + cfg.tsStepUs
  }
  report({emittedX: emitted, ts})
}

function* stairsShape(
  cfg: NormalizedOpts,
  manifest: SyntheticTraceManifest,
  pid: number,
  tid: number,
  baseTs: number,
  count: number,
  emit: (obj: Record<string, unknown>) => string,
  report: (refs: {emittedX: number; ts: number}) => void,
): Generator<string, void, void> {
  // Wide parent covering K children that are each sub-resolution. Great
  // for exercising the CPU-profile-style tiny-frame compactor path.
  const wide = cfg.tsStepUs * 32
  const tiny = 1
  let emitted = 0
  let ts = baseTs
  const childrenPerParent = 32
  manifest.maxDepth = Math.max(manifest.maxDepth, 2)
  while (emitted < count) {
    yield emit({
      ph: 'X',
      name: 'StairsParent',
      cat: cfg.category,
      pid,
      tid,
      ts,
      dur: wide,
    })
    emitted += 1
    manifest.xEventCount += 1
    for (let k = 0; k < childrenPerParent && emitted < count; k++) {
      yield emit({
        ph: 'X',
        name: `tiny${k % 4}`,
        cat: cfg.category,
        pid,
        tid,
        ts: ts + k * tiny,
        dur: tiny,
      })
      emitted += 1
      manifest.xEventCount += 1
    }
    ts += wide + cfg.tsStepUs
  }
  report({emittedX: emitted, ts})
}

/**
 * Emit a V8 `Profile` opener + a single `ProfileChunk` whose node tree
 * has `cpuNodeCount` distinct JS functions parented under a shared
 * `(program)` node, then dispatch samples uniformly across those leaves.
 */
function* cpuProfile(
  cfg: NormalizedOpts,
  emit: (obj: Record<string, unknown>) => string,
): Generator<string, void, void> {
  const pid = 1000
  const tid = 1
  const profileId = '0x1'

  yield emit({
    ph: 'P',
    name: 'Profile',
    cat: 'v8',
    pid,
    tid,
    ts: 0,
    id: profileId,
    args: {data: {startTime: 0}},
  })

  // Node tree: 1=(root), 2=(program), 3..3+cpuNodeCount-1 = user fns.
  const nodes: Array<Record<string, unknown>> = [
    {id: 1, callFrame: {functionName: '(root)', scriptId: 0, codeType: 'other'}},
    {
      id: 2,
      parent: 1,
      callFrame: {functionName: '(program)', scriptId: 0, codeType: 'other'},
    },
  ]
  for (let n = 0; n < cfg.cpuNodeCount; n++) {
    nodes.push({
      id: 3 + n,
      parent: 2,
      callFrame: {
        functionName: `fn${n}`,
        scriptId: 1,
        url: 'synth.js',
        lineNumber: n + 1,
        columnNumber: 1,
      },
    })
  }

  const samples: number[] = new Array(cfg.jsSampleCount)
  const timeDeltas: number[] = new Array(cfg.jsSampleCount)
  for (let i = 0; i < cfg.jsSampleCount; i++) {
    samples[i] = 3 + (i % cfg.cpuNodeCount)
    timeDeltas[i] = 25 // 25 µs between samples (~40 kHz)
  }

  yield emit({
    ph: 'P',
    name: 'ProfileChunk',
    cat: 'v8',
    pid,
    tid,
    ts: 0,
    id: profileId,
    args: {data: {cpuProfile: {nodes, samples}, timeDeltas}},
  })
}

