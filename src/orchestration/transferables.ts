import type {ParsedTrace} from '../core'

/**
 * Walk every `Track` in a finalized trace and clear the recursive
 * `Measure.measures` / `Measure.marks` arrays in place.
 *
 * Why this exists: V8's structured-clone serializer recurses on object
 * graphs, with one frame per nesting level. A Chrome CPU-profile trace
 * with deep async stacks produces a `Measure` tree thousands of nodes
 * deep, and `worker.postMessage(trace)` blows the stack with
 * `RangeError: Maximum call stack size exceeded` long before it sends
 * a single byte. The fix is to stop sending the tree at all — every
 * field the main thread reads (depth, parent index, color, hit-test
 * lookup) is already mirrored in the flat `track.buffers` SoA, so we
 * iterate `buffers.measures` (a flat list of references to *every*
 * Measure in the subtree, including nested ones) and replace each
 * Measure's child arrays with empty arrays. The flat references are
 * still distinct objects whose scalar fields (`id`, `name`, `start`,
 * `end`, `category`, etc.) survive the clone unchanged; only the
 * recursion is severed.
 *
 * The marks list gets the same treatment: `track.markBuffers` already
 * carries every nested `Mark`, so per-measure `marks: []` is safe to
 * clear.
 *
 * After calling this the worker-side `ParsedTrace` is no longer a
 * traversable tree — only the flat buffers + transferred typed-arrays
 * remain. We only call it at the very end of `runParse`, immediately
 * before `postMessage`, and the worker terminates after the message
 * is sent.
 */
export function stripParsedTreeForTransfer(trace: ParsedTrace): void {
  const EMPTY_MEASURES: never[] = []
  const EMPTY_MARKS: never[] = []
  for (const system of trace.timeline.systems) {
    for (const track of system.tracks) {
      const buffers = track.buffers
      if (buffers) {
        const measures = buffers.measures
        for (let i = 0; i < buffers.count; i++) {
          const m = measures[i]
          // Cast through unknown so we can drop the reference even
          // though `Measure.measures` is non-optional in the type.
          // The main thread's consumers don't read this field — they
          // walk `buffers` instead — so the type-level guarantee is
          // preserved at the public boundary.
          ;(m as unknown as {measures: unknown[]}).measures = EMPTY_MEASURES
          ;(m as unknown as {marks: unknown[]}).marks = EMPTY_MARKS
        }
      }
      // The track itself also references its top-level measures + marks
      // recursively through `track.measures`. Drop those so the clone
      // doesn't even start a recursion.
      ;(track as unknown as {measures: unknown[]}).measures = EMPTY_MEASURES
      ;(track as unknown as {marks: unknown[]}).marks = EMPTY_MARKS
    }
  }
}

/**
 * Walk a finalized ParsedTrace and collect every typed-array backing
 * buffer so the worker can hand ownership of them to the main thread
 * via `postMessage(msg, transferList)` instead of structured-cloning
 * them. For a 1GB trace these buffers dominate the message payload —
 * rough numbers: ~80 MB of Float32/Uint32 across `SliceBuffers` +
 * mipmap levels + `MarkBuffers`. Cloning copies them; transferring
 * neuters the worker-side view and gifts the memory to the main
 * thread in constant time.
 *
 * IMPORTANT: After calling this in the worker, do not read the source
 * trace's typed arrays — their `.buffer` has been detached. We only
 * call this right before `postMessage`, and the worker terminates
 * after the message is sent.
 */
export function collectParsedTraceTransferables(trace: ParsedTrace): ArrayBuffer[] {
  const out: ArrayBuffer[] = []
  const seen = new Set<ArrayBuffer>()

  const add = (ab: ArrayBufferLike | undefined | null): void => {
    if (!ab) return
    // `ArrayBufferLike` can legitimately be a `SharedArrayBuffer`; those
    // aren't transferable, and our builders only produce plain
    // `ArrayBuffer`s, but guard anyway.
    if (!(ab instanceof ArrayBuffer)) return
    if (seen.has(ab)) return
    seen.add(ab)
    out.push(ab)
  }

  for (const system of trace.timeline.systems) {
    for (const track of system.tracks) {
      const buf = track.buffers
      if (buf) {
        add(buf.starts.buffer)
        add(buf.ends.buffer)
        add(buf.depths.buffer)
        add(buf.colors.buffer)
        add(buf.maxEndsPrefix.buffer)
        add(buf.parentEnds.buffer)
        add(buf.parentIndex.buffer)
      }
      const marks = track.markBuffers
      if (marks) {
        add(marks.times.buffer)
        add(marks.depths.buffer)
        add(marks.colors.buffer)
      }
      const mip = track.mipmap
      if (mip) {
        for (const lvl of mip.levels) {
          add(lvl.starts.buffer)
          add(lvl.ends.buffer)
          add(lvl.depths.buffer)
          add(lvl.colors.buffer)
          add(lvl.maxEndsPrefix.buffer)
          add(lvl.counts.buffer)
          add(lvl.sourceStart.buffer)
        }
      }
    }
  }

  return out
}
