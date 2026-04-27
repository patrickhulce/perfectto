/**
 * Browser-side download trigger for compacted-trace exports.
 *
 * The core layer ({@link import('../core/export/zipCompactedTrace').zipCompactedTrace})
 * produces a `ReadableStream<Uint8Array>` of gzipped JSON; this helper
 * turns that stream into a real disk download by buffering it into a
 * {@link Blob}, attaching it to a synthetic `<a download>`, and
 * clicking it programmatically.
 *
 * Why a blob (instead of streaming straight to disk via the File
 * System Access API)? Compacted exports are tiny by construction —
 * the whole point of the feature is to shrink hundred-of-megabytes
 * traces into a few MB of compacted measures, so buffering before
 * the download is fine and works in every browser without a
 * permission prompt.
 */

/**
 * Collect a stream of byte chunks, wrap it in a `Blob`, and trigger a
 * file save with the given name. Resolves once the download has been
 * dispatched (the browser handles the rest asynchronously).
 *
 * Throws if invoked outside a DOM environment — call sites should
 * either guard on `typeof document !== 'undefined'` or only render
 * the download button when the host supports it.
 */
export async function triggerDownload(
  stream: ReadableStream<Uint8Array>,
  filename: string,
): Promise<void> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    throw new Error('triggerDownload requires a DOM environment.')
  }

  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  try {
    while (true) {
      const {value, done} = await reader.read()
      if (done) break
      if (value && value.byteLength > 0) chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Reader may have already been released; not fatal.
    }
  }

  // The cast is needed because TS's `Uint8Array` generic argument has
  // tightened recently (`ArrayBufferLike` vs `ArrayBuffer`) but the
  // values are valid `BlobPart`s at runtime in every browser we
  // support. Same pattern used for `pipeThrough(new
  // CompressionStream(...))` in the core export.
  const blob = new Blob(chunks as BlobPart[], {type: 'application/gzip'})
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    // Firefox requires the anchor to be in the DOM before `.click()`
    // dispatches a real navigation; Chromium tolerates a detached
    // node. Append + remove so we don't leak DOM nodes.
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
  } finally {
    // Revoke on the next tick so the click handler has had a chance
    // to start the download. Synchronous revoke can race the browser
    // and produce an empty file in some Safari builds.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
