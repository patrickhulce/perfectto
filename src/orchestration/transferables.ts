import type {ParsedTrace} from '../core'

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
