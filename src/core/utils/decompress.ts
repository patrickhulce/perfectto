/**
 * gzip detection + transparent decompression for trace input streams.
 *
 * We accept gzipped traces in two ways:
 *
 *   1. **File extension hint** — `.gz` / `.gzip` (also detects compound
 *      extensions like `.json.gz`). Cheap and works before we read any
 *      bytes; useful for surfacing the "we'll decompress" decision early.
 *   2. **Magic bytes** — the gzip header always starts with `0x1f 0x8b`.
 *      We peek the first chunk of the stream; if it matches we decompress
 *      regardless of filename. This covers files renamed to `.json` /
 *      `.txt` after gzipping, as well as drag-and-drop of raw blobs.
 *
 * Decompression is done with the Streams-native `DecompressionStream`,
 * which is available everywhere we run (Chrome 80+, Node 18+). We still
 * gate on its existence so a bare-bones environment falls back to
 * passing the stream through unchanged — the parser's magic-byte sniff
 * will then reject the gzip header with a clear "unsupported format"
 * message.
 */

const GZIP_MAGIC_0 = 0x1f
const GZIP_MAGIC_1 = 0x8b

/**
 * Returns true if `name` looks like a gzipped file based on its
 * extension. Recognizes `.gz` and `.gzip` (case-insensitive); does
 * **not** match `.tgz` because tarballs aren't a single trace file.
 */
export function hasGzipExtension(name: string | undefined): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  return lower.endsWith('.gz') || lower.endsWith('.gzip')
}

/**
 * Returns true if `bytes` begins with the gzip magic header.
 * Two-byte check is sufficient — gzip mandates `1f 8b` and no other
 * format we care about (Chrome JSON, Perfetto protobuf, Linux ftrace)
 * collides on those two bytes.
 */
export function hasGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1
}

/**
 * Inspects the first chunk of `stream`; if the chunk's magic bytes (or
 * the supplied `hint.name` extension) indicate gzip, returns a new
 * stream that yields the *decompressed* bytes. Otherwise returns a
 * stream equivalent to the input (the peeked chunk is re-prepended so
 * downstream consumers still see byte 0).
 *
 * The returned stream owns the original — callers must not read from
 * `stream` afterwards.
 */
export async function maybeDecompressGzip(
  stream: ReadableStream<Uint8Array>,
  hint?: {name?: string},
): Promise<ReadableStream<Uint8Array>> {
  const reader = stream.getReader()
  let firstChunk: Uint8Array | null = null
  let done = false
  // Skip empty chunks so the magic check sees real bytes. Web platform
  // streams legally emit zero-length Uint8Arrays on flush boundaries.
  while (!done) {
    const result = await reader.read()
    if (result.done) {
      done = true
      break
    }
    const value = result.value
    if (value && value.byteLength > 0) {
      firstChunk = value
      break
    }
  }

  const looksGzipped =
    (firstChunk !== null && hasGzipMagic(firstChunk)) || hasGzipExtension(hint?.name)

  // Reconstruct a stream that replays the peeked chunk, then forwards
  // everything else from the original reader. We must do this whether
  // or not we decompress, because we already consumed the first chunk.
  const replayed = new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstChunk) controller.enqueue(firstChunk)
      if (done) {
        controller.close()
        try {
          reader.releaseLock()
        } catch {
          // Reader may have already been released; not fatal.
        }
      }
    },
    async pull(controller) {
      try {
        const {value, done: streamDone} = await reader.read()
        if (streamDone) {
          controller.close()
          try {
            reader.releaseLock()
          } catch {
            // see above
          }
          return
        }
        if (value) controller.enqueue(value)
      } catch (err) {
        controller.error(err)
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {})
    },
  })

  if (!looksGzipped) return replayed

  if (typeof DecompressionStream === 'undefined') {
    // Surface a precise error rather than letting the parser see the
    // gzip header and emit a generic "unsupported format" message.
    throw new Error(
      'Trace looks gzipped (magic bytes 1f 8b) but DecompressionStream is unavailable in this environment.',
    )
  }

  return replayed.pipeThrough(new DecompressionStream('gzip'))
}
