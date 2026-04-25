import type {ParsedTrace, ParseOptions, ParseProgress, TraceInput, TraceSource} from '../types'
import {maybeDecompressGzip} from '../utils/decompress'
import {yieldToEventLoop} from '../utils/yieldToEventLoop'
import {ChromeParser} from './chrome/chrome-parser'
import type {TraceParser, TraceParserConstructor} from './types'

const PARSERS: TraceParserConstructor[] = [ChromeParser]
const SNIFF_LIMIT = 8 * 1024
const THROTTLE_BYTES = 64 * 1024
const THROTTLE_MS = 50

/**
 * Streaming entry point. Buffers up to {@link SNIFF_LIMIT} bytes and searches
 * for each registered parser's static `MAGIC_PATTERN`. Once a parser matches,
 * the entire sniff buffer is replayed to it (so the parser always sees bytes
 * from byte 0), after which every subsequent chunk is forwarded directly.
 */
export async function parseTrace(
  input: TraceInput,
  source: TraceSource,
  options?: ParseOptions,
): Promise<ParsedTrace> {
  const {signal, onProgress, chromeParser: chromeParserOptions, maxBytes} = options ?? {}
  throwIfAborted(signal)

  const cap =
    typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
      ? maxBytes
      : Infinity

  let parser: TraceParser | null = null
  let sniffBuf: Uint8Array = new Uint8Array(0)
  let bytesRead = 0
  let streamIndex = 0
  let lastEmitBytes = 0
  let lastEmitTime = 0
  let truncated = false

  const emit = (
    phase: ParseProgress['phase'],
    force: boolean,
    detail?: string,
  ): void => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && bytesRead - lastEmitBytes < THROTTLE_BYTES && now - lastEmitTime < THROTTLE_MS) {
      return
    }
    lastEmitBytes = bytesRead
    lastEmitTime = now
    onProgress({streamIndex, bytesRead, phase, detail})
  }

  outer: for await (const rawStream of normalizeInput(input)) {
    throwIfAborted(signal)
    // Peek + (maybe) decompress before the parser sees byte 0. The
    // detector returns the original stream untouched if the input
    // isn't gzipped, so this is cheap on the common path. Note that
    // `bytesRead` will track *decompressed* bytes from here on; for
    // gzipped inputs that won't line up with `source.size` (compressed
    // size) — the progress UI just overshoots toward the end.
    const stream = await maybeDecompressGzip(rawStream, {name: source.name})
    const reader = stream.getReader()
    const cancelOnAbort = (): void => {
      reader.cancel(abortReason(signal)).catch(() => {})
    }
    signal?.addEventListener('abort', cancelOnAbort)
    try {
      while (true) {
        throwIfAborted(signal)
        const {value, done} = await reader.read()
        if (done) break
        if (!value || value.byteLength === 0) continue

        bytesRead += value.byteLength

        if (parser) {
          parser.write(value)
        } else {
          sniffBuf = concatBytes(sniffBuf, value)
          const matched = findParser(sniffBuf)
          if (matched) {
            parser = new matched(chromeParserOptions)
            const replay = sniffBuf
            sniffBuf = new Uint8Array(0)
            parser.write(replay)
          } else if (sniffBuf.byteLength >= SNIFF_LIMIT) {
            throw unsupportedFormatError()
          }
        }
        emit('parsing', false)
        // Yield so our host (usually a Worker) can drain its message queue:
        // outgoing progress posts, incoming abort requests, etc.
        await yieldToEventLoop()

        if (bytesRead >= cap) {
          // Soft cap hit: stop reading, surface the truncation in
          // progress, and fall through to finalize on whatever's been
          // collected so the user still gets *something* to inspect.
          truncated = true
          reader.cancel('maxBytes exceeded').catch(() => {})
          emit('parsing', true, 'truncated')
          break outer
        }
      }
    } finally {
      signal?.removeEventListener('abort', cancelOnAbort)
      try {
        reader.releaseLock()
      } catch {
        // Reader was already released via cancel().
      }
    }
    throwIfAborted(signal)
    emit('parsing', true)
    streamIndex += 1
  }

  if (!parser) {
    // Final chance: short stream that never crossed SNIFF_LIMIT.
    const matched = findParser(sniffBuf)
    if (matched) {
      parser = new matched(chromeParserOptions)
      parser.write(sniffBuf)
    } else {
      throw unsupportedFormatError()
    }
  }

  emit('finalizing', true)
  const trace = await parser.finalize(source, {
    signal,
    onProgress,
    bytesRead,
    streamIndex,
    truncated,
  })
  if (truncated) {
    // Surface truncation in metadata so the viewer's metadata pane can
    // tell the user "this trace was cut short at N MB". We don't
    // promote it to a parser error because finalize succeeded — the
    // partial trace is genuinely usable.
    trace.metadata.truncated = true
    trace.metadata.truncatedAtBytes = bytesRead
    trace.metadata.truncatedAtMaxBytes = Number.isFinite(cap) ? cap : undefined
  }
  emit('done', true)
  return trace
}

function findParser(buf: Uint8Array): TraceParserConstructor | null {
  for (const P of PARSERS) {
    if (indexOfBytes(buf, P.MAGIC_PATTERN) !== -1) return P
  }
  return null
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0
  const last = haystack.length - needle.length
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a, 0)
  out.set(b, a.byteLength)
  return out
}

function unsupportedFormatError(): Error {
  return new Error(
    `Unsupported trace format: no registered parser matched the first ${SNIFF_LIMIT} bytes`,
  )
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal | undefined): unknown {
  const reason = signal?.reason
  if (reason !== undefined && reason !== null) return reason
  return new DOMException('Aborted', 'AbortError')
}

async function* normalizeInput(input: TraceInput): AsyncIterable<ReadableStream<Uint8Array>> {
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
