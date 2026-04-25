#!/usr/bin/env tsx
// Quick smoke for the gzipped chrome trace: stream the file through
// parseTrace, then run stripParsedTreeForTransfer to confirm the worker
// path won't blow the stack on this trace.
//
// Usage:
//   pnpm exec tsx scripts/smoke-gz-trace.ts [path/to/trace.json.gz]

import {createReadStream, statSync} from 'node:fs'
import {Readable} from 'node:stream'
import path from 'node:path'

import {parseTrace} from '../src/core/parser'
import {stripParsedTreeForTransfer} from '../src/orchestration/transferables'

async function main(): Promise<void> {
  const filePath = process.argv[2] || 'test-results/chrome_trace_hf_compiled.json.gz'
  const abs = path.resolve(filePath)
  const size = statSync(abs).size
  console.log(`smoke: ${abs} (${(size / 1024 / 1024).toFixed(1)} MiB compressed)`)

  const nodeStream = createReadStream(abs)
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>

  const t0 = Date.now()
  let lastDetail = ''
  let lastFraction = -1
  const trace = await parseTrace(
    webStream,
    {name: path.basename(abs), size},
    {
      onProgress: p => {
        if (p.detail && p.detail !== lastDetail) {
          lastDetail = p.detail
          const frac = p.events ? p.events.processed / p.events.total : null
          const pct =
            frac !== null ? `${(frac * 100).toFixed(1)}%` : `${(p.bytesRead / 1024 / 1024).toFixed(1)} MiB`
          console.log(`[${p.phase}] ${pct} · ${p.detail}`)
        } else if (p.events) {
          // Surface event-count motion even when the detail string is
          // unchanged — that's the signal the cull/compact passes are
          // making progress through a single big track.
          const frac = p.events.processed / p.events.total
          if (frac - lastFraction > 0.05) {
            lastFraction = frac
            console.log(`[${p.phase}] ${(frac * 100).toFixed(1)}%`)
          }
        }
      },
    },
  )
  const parseMs = Date.now() - t0
  console.log(`parse + finalize: ${parseMs} ms`)
  console.log(`systems: ${trace.timeline.systems.length}`)
  const c = trace.metadata.compaction
  if (c) {
    console.log(
      `compaction: subpixel=${c.subpixelEventsFolded} (${c.subpixelSubtreesFolded} subtrees, max depth ${c.subpixelMaxDepthFolded}) · ` +
        `cpu-tiny=${c.cpuTinyEventsFolded} · sibling=${c.siblingEventsFolded} · online=${c.onlineEventsFolded}`,
    )
  }

  let totalSlices = 0
  let maxDepth = 0
  for (const sys of trace.timeline.systems) {
    for (const trk of sys.tracks) {
      if (trk.buffers) {
        totalSlices += trk.buffers.count
        for (let i = 0; i < trk.buffers.count; i++) {
          if (trk.buffers.depths[i] > maxDepth) maxDepth = trk.buffers.depths[i]
        }
      }
    }
  }
  console.log(`total slices: ${totalSlices}, max depth: ${maxDepth}`)

  const t1 = Date.now()
  stripParsedTreeForTransfer(trace)
  const stripMs = Date.now() - t1
  console.log(`stripParsedTreeForTransfer: ${stripMs} ms`)
  console.log('OK')
}

void main()
  .then(() => {
    // Force-exit so the script doesn't sit on an idle Readable handle
    // / keepalive once we're done. main() has already validated the
    // entire happy path; nothing observable changes after this point.
    process.exit(0)
  })
  .catch(err => {
    console.error('smoke failed:', err)
    process.exit(1)
  })
