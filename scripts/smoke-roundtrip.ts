#!/usr/bin/env tsx
// Roundtrip smoke for the compacted-trace export. Runs the real
// gzipped chrome trace asset through `parseTrace` once, then
// repeatedly through `zipCompactedTrace` → `parseTrace`, asserting:
//
//   * Cycle N+1's ParsedTrace is structurally equivalent to cycle N
//     (same systems/tracks/measures/marks, same compaction counters).
//   * Gzipped bytes are identical from cycle 2 onward (the export is
//     a fixed point once the lossy first compaction has run).
//
// Usage:
//   pnpm exec tsx scripts/smoke-roundtrip.ts [path/to/trace.json.gz]
//   pnpm run smoke:roundtrip

import {createReadStream, statSync} from 'node:fs'
import path from 'node:path'
import {Readable} from 'node:stream'

import type {Mark, Measure, ParsedTrace, System, Track} from '../src/core'
import {parseTrace} from '../src/core/parser'
import {streamCompactedJson, zipCompactedTrace} from '../src/core/export/zipCompactedTrace'
import {stripParsedTreeForTransfer} from '../src/orchestration/transferables'

const NUM_CYCLES = 3
// Float drift on the µs ↔ ms boundary tops out at half a microsecond
// per conversion, doubled for safety. Anything wider than this is a
// real divergence we want to fail on.
const TIME_TOLERANCE_MS = 1e-3

interface CycleStats {
  bytesOut: number
  parseMs: number
  exportMs: number
  systems: number
  totalMeasures: number
  totalMarks: number
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
  // Mirror the browser pipeline: the parser worker calls
  // `stripParsedTreeForTransfer` on the trace before posting it to
  // the main thread, which empties every recursive
  // `track.measures` / `Measure.measures` / `Measure.marks` array.
  // The export must read from `track.buffers` / `track.markBuffers`
  // in that mode. `--strip` makes the smoke do the same so we keep
  // that code path covered locally.
  const stripBetweenCycles = process.argv.includes('--strip')
  const filePath = args[0] || 'test-results/chrome_trace_hf_compiled.json.gz'
  const abs = path.resolve(filePath)
  const size = statSync(abs).size
  console.log(`smoke: ${abs} (${(size / 1024 / 1024).toFixed(1)} MiB compressed)`)
  if (stripBetweenCycles) {
    console.log('mode: --strip (simulating worker → main-thread tree strip)')
  }

  const t0 = Date.now()
  const initialStream = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream<Uint8Array>
  let current = await parseTrace(initialStream, {name: path.basename(abs), size})
  if (stripBetweenCycles) stripParsedTreeForTransfer(current)
  const initialParseMs = Date.now() - t0
  console.log(`initial parse: ${initialParseMs} ms · ${describeTrace(current)}`)

  const cycles: CycleStats[] = []
  const bytesPerCycle: Uint8Array[] = []
  const jsonPerCycle: Uint8Array[] = []

  for (let i = 1; i <= NUM_CYCLES; i++) {
    const exportStart = Date.now()
    const bytes = await collectBytes(zipCompactedTrace(current))
    const json = await collectBytes(streamCompactedJson(current))
    const exportMs = Date.now() - exportStart

    const parseStart = Date.now()
    // Use a stable name across cycles. The exporter writes the source
    // name into the `_pfctoExport` marker, so reusing the same name on
    // every re-parse keeps the marker (and therefore the gzipped
    // bytes) byte-identical from cycle 2 → cycle 3 → ….
    const next = await parseTrace(streamFromBytes(bytes), {
      name: 'roundtrip.compacted.json.gz',
      size: bytes.byteLength,
    })
    const parseMs = Date.now() - parseStart

    let totalMeasures = 0
    let totalMarks = 0
    for (const sys of next.timeline.systems) {
      for (const trk of sys.tracks) {
        totalMeasures += trk.buffers ? trk.buffers.count : countMeasures(trk.measures)
        totalMarks += trk.markBuffers ? trk.markBuffers.count : trk.marks.length
      }
    }
    const stats: CycleStats = {
      bytesOut: bytes.byteLength,
      parseMs,
      exportMs,
      systems: next.timeline.systems.length,
      totalMeasures,
      totalMarks,
    }
    cycles.push(stats)
    bytesPerCycle.push(bytes)
    jsonPerCycle.push(json)

    console.log(
      `cycle ${i}: export ${exportMs} ms · parse ${parseMs} ms · ` +
        `${(bytes.byteLength / 1024 / 1024).toFixed(2)} MiB · ` +
        `${stats.systems} systems · ${stats.totalMeasures.toLocaleString()} measures · ` +
        `${stats.totalMarks.toLocaleString()} marks`,
    )

    // First export comes off the original parse, which is intentionally
    // lossy (compaction runs once on raw events). Compare cycle N → N+1
    // for N >= 1, where both inputs were already compacted. Skip the
    // structural compare under --strip: the previous cycle's `prev`
    // had its measure tree zeroed for the simulated postMessage, so
    // walking `prev.timeline.systems[i].tracks[j].measures` finds
    // nothing. The byte-equality check below is a strictly stronger
    // assertion in that mode anyway.
    if (i >= 2 && !stripBetweenCycles) {
      const prev = current
      assertStructurallyEqual(prev, next, i)
    }
    current = next
    if (stripBetweenCycles) stripParsedTreeForTransfer(current)
  }

  // Cycle 1's output is lossy (it's the first time compaction ran on
  // the raw events). From cycle 2 onward the export operates on a
  // pre-compacted tree and must be a fixed point — bytes equal,
  // structural compare equal.
  for (let i = 2; i < bytesPerCycle.length; i++) {
    if (!bytesEqual(bytesPerCycle[i], bytesPerCycle[i - 1])) {
      const jsonDiff = firstByteDiff(jsonPerCycle[i - 1], jsonPerCycle[i])
      const a = new TextDecoder().decode(jsonPerCycle[i - 1])
      const b = new TextDecoder().decode(jsonPerCycle[i])
      const ctxStart = Math.max(0, jsonDiff - 80)
      const ctxEnd = Math.min(a.length, jsonDiff + 80)
      throw new Error(
        `cycle ${i + 1} bytes differ from cycle ${i} ` +
          `(gzip ${bytesPerCycle[i].byteLength} vs ${bytesPerCycle[i - 1].byteLength}; ` +
          `json ${jsonPerCycle[i].byteLength} vs ${jsonPerCycle[i - 1].byteLength}). ` +
          `First JSON diff at byte ${jsonDiff}.\n` +
          `prev: …${a.slice(ctxStart, ctxEnd)}…\n` +
          `next: …${b.slice(ctxStart, ctxEnd)}…`,
      )
    }
  }

  console.log(
    `byte-equality: cycles 2..${NUM_CYCLES} all produce identical gzipped output.`,
  )
  console.log('OK')
}

function describeTrace(trace: ParsedTrace): string {
  const c = trace.metadata.compaction
  let measures = 0
  let marks = 0
  for (const sys of trace.timeline.systems) {
    for (const trk of sys.tracks) {
      // After `stripParsedTreeForTransfer`, `track.measures` /
      // `track.marks` are empty; the canonical count lives in the
      // flat buffers. Prefer those when present so the post-strip
      // describe still prints non-zero counts.
      measures += trk.buffers ? trk.buffers.count : countMeasures(trk.measures)
      marks += trk.markBuffers ? trk.markBuffers.count : trk.marks.length
    }
  }
  const compaction = c
    ? ` · compaction sibling=${c.siblingEventsFolded} cpu-tiny=${c.cpuTinyEventsFolded} ` +
      `subpixel=${c.subpixelEventsFolded} online=${c.onlineEventsFolded}`
    : ''
  return (
    `${trace.timeline.systems.length} systems · ${measures.toLocaleString()} measures · ` +
    `${marks.toLocaleString()} marks${compaction}`
  )
}

function countMeasures(measures: Measure[]): number {
  let n = 0
  for (const m of measures) n += 1 + countMeasures(m.measures)
  return n
}

function assertStructurallyEqual(a: ParsedTrace, b: ParsedTrace, cycle: number): void {
  if (a.timeline.systems.length !== b.timeline.systems.length) {
    throw new Error(
      `cycle ${cycle}: system count drift ${a.timeline.systems.length} → ${b.timeline.systems.length}`,
    )
  }
  if (!approxEqual(a.timeline.start, b.timeline.start)) {
    throw new Error(`cycle ${cycle}: timeline.start drift ${a.timeline.start} → ${b.timeline.start}`)
  }
  if (!approxEqual(a.timeline.end, b.timeline.end)) {
    throw new Error(`cycle ${cycle}: timeline.end drift ${a.timeline.end} → ${b.timeline.end}`)
  }
  const ac = a.metadata.compaction
  const bc = b.metadata.compaction
  if (canonicalJson(ac) !== canonicalJson(bc)) {
    throw new Error(
      `cycle ${cycle}: compaction-counter drift\n  prev=${canonicalJson(ac)}\n  next=${canonicalJson(bc)}`,
    )
  }
  for (let i = 0; i < a.timeline.systems.length; i++) {
    assertSystemsEqual(a.timeline.systems[i], b.timeline.systems[i], cycle, `system[${i}]`)
  }
}

function assertSystemsEqual(a: System, b: System, cycle: number, breadcrumb: string): void {
  if (a.name !== b.name) {
    throw new Error(`cycle ${cycle}: ${breadcrumb} name drift ${a.name} → ${b.name}`)
  }
  if (a.tracks.length !== b.tracks.length) {
    throw new Error(
      `cycle ${cycle}: ${breadcrumb} track count drift ${a.tracks.length} → ${b.tracks.length}`,
    )
  }
  for (let i = 0; i < a.tracks.length; i++) {
    assertTracksEqual(a.tracks[i], b.tracks[i], cycle, `${breadcrumb}.track[${i}]`)
  }
}

function assertTracksEqual(a: Track, b: Track, cycle: number, breadcrumb: string): void {
  if (a.name !== b.name) {
    throw new Error(`cycle ${cycle}: ${breadcrumb} name drift ${a.name} → ${b.name}`)
  }
  assertContainerEqual(a, b, cycle, breadcrumb)
}

function assertContainerEqual(
  a: {marks: Mark[]; measures: Measure[]},
  b: {marks: Mark[]; measures: Measure[]},
  cycle: number,
  breadcrumb: string,
): void {
  if (a.measures.length !== b.measures.length) {
    throw new Error(
      `cycle ${cycle}: ${breadcrumb} measure count drift ${a.measures.length} → ${b.measures.length}`,
    )
  }
  if (a.marks.length !== b.marks.length) {
    throw new Error(
      `cycle ${cycle}: ${breadcrumb} mark count drift ${a.marks.length} → ${b.marks.length}`,
    )
  }
  const aMeasures = [...a.measures].sort(measureCompare)
  const bMeasures = [...b.measures].sort(measureCompare)
  for (let i = 0; i < aMeasures.length; i++) {
    assertMeasureEqual(aMeasures[i], bMeasures[i], cycle, `${breadcrumb}.measure[${i}]`)
  }
  const aMarks = [...a.marks].sort(markCompare)
  const bMarks = [...b.marks].sort(markCompare)
  for (let i = 0; i < aMarks.length; i++) {
    if (aMarks[i].name !== bMarks[i].name) {
      throw new Error(
        `cycle ${cycle}: ${breadcrumb}.mark[${i}] name drift ${aMarks[i].name} → ${bMarks[i].name}`,
      )
    }
    if (!approxEqual(aMarks[i].time, bMarks[i].time)) {
      throw new Error(
        `cycle ${cycle}: ${breadcrumb}.mark[${i}] time drift ${aMarks[i].time} → ${bMarks[i].time}`,
      )
    }
  }
}

function assertMeasureEqual(a: Measure, b: Measure, cycle: number, breadcrumb: string): void {
  if (a.name !== b.name) {
    throw new Error(`cycle ${cycle}: ${breadcrumb} name drift ${a.name} → ${b.name}`)
  }
  if (a.category !== b.category) {
    throw new Error(`cycle ${cycle}: ${breadcrumb} category drift ${a.category} → ${b.category}`)
  }
  if (!approxEqual(a.start, b.start) || !approxEqual(a.end, b.end)) {
    throw new Error(
      `cycle ${cycle}: ${breadcrumb} time drift [${a.start}, ${a.end}] → [${b.start}, ${b.end}]`,
    )
  }
  if (a.color !== b.color) {
    throw new Error(`cycle ${cycle}: ${breadcrumb} color drift ${a.color} → ${b.color}`)
  }
  if (canonicalJson(a.attribution) !== canonicalJson(b.attribution)) {
    throw new Error(
      `cycle ${cycle}: ${breadcrumb} attribution drift\n  prev=${canonicalJson(a.attribution)}\n  next=${canonicalJson(b.attribution)}\n  measure name=${a.name} cat=${a.category}`,
    )
  }
  if (canonicalJson(a.compaction) !== canonicalJson(b.compaction)) {
    throw new Error(
      `cycle ${cycle}: ${breadcrumb} compaction-report drift\n  prev=${canonicalJson(a.compaction)}\n  next=${canonicalJson(b.compaction)}`,
    )
  }
  assertContainerEqual(a, b, cycle, breadcrumb)
}

function measureCompare(a: Measure, b: Measure): number {
  if (a.start !== b.start) return a.start - b.start
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.end - b.end
}

function markCompare(a: Mark, b: Mark): number {
  if (a.time !== b.time) return a.time - b.time
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= TIME_TOLERANCE_MS
}

async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Stable JSON serialization with keys sorted recursively. Used by the
 * structural comparator so that two attribution objects with identical
 * content but different key insertion order (e.g. one came off the
 * Kineto-python branch of the parser, the other off the export's
 * `serializeAttribution`) compare equal. Byte-stability of the export
 * is enforced separately via the gzipped-output equality check.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = obj[k]
      }
      return sorted
    }
    return v
  })
}

function firstByteDiff(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.byteLength, b.byteLength)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i
  }
  return len
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

void main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('roundtrip smoke failed:', err)
    process.exit(1)
  })
