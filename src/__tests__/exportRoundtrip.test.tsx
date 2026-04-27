import {readFile} from 'node:fs/promises'
import path from 'node:path'

import {act, fireEvent, render, screen} from '@testing-library/react'

import Metadata from '../components/Metadata'
import {parseTrace} from '../core/parser'
import type {
  CompactionReport,
  Mark,
  Measure,
  ParsedTrace,
  System,
  Track,
  TraceSource,
} from '../core'
import {
  streamCompactedJson,
  suggestExportFilename,
  zipCompactedTrace,
} from '../core/export/zipCompactedTrace'

import {stripParsedTreeForTransfer} from '../orchestration/transferables'

import {streamSyntheticTrace} from './fixtures/generateChromeTrace'

/**
 * `Measure.start`/`end` flow through `(rawTs - origin) / 1000` →
 * `Math.round(ms * 1000) / 1000` on roundtrip. The maximum drift
 * across one cycle is half a microsecond. We use `1e-3` ms (1 µs)
 * as the tie tolerance — well above the float noise, well below
 * any meaningful event duration.
 */
const TIME_TOLERANCE_MS = 1e-3

// Use a `.json` (not `.json.gz`) name so `maybeDecompressGzip` only
// triggers when the input bytes carry the gzip magic header. The
// roundtrip tests feed both raw JSON (initial parse) and gzipped
// bytes (cycle 2+) into `parseTrace` with the same source name; the
// magic-byte sniff handles the gzipped case correctly.
const SOURCE: TraceSource = {name: 'roundtrip-test.json', size: 0}

interface CompareOptions {
  /**
   * Whether to require strictly equal `Track.category` strings.
   *
   * The chrome parser re-derives every re-imported track as
   * `'thread'` regardless of the input M event content. Cycle 1 →
   * cycle 2 may therefore drift on this field; cycle 2 → cycle 3
   * (and beyond) is stable, so we relax the check on the first
   * comparison and tighten it for steady-state cycles.
   */
  requireTrackCategory?: boolean
  /**
   * Whether to compare `Track.id` / `System.id` strings. Same
   * rationale as `requireTrackCategory`: ids encode the original
   * `pid`/`tid`, which we don't preserve across the lossy first
   * cycle but DO produce deterministically from system/track index
   * after the first export. Enabled for cycle 2 → cycle 3 etc.
   */
  requireIds?: boolean
}

/**
 * Structural equality check used by every roundtrip case.
 * Asserts that the in-memory `ParsedTrace`s describe the same
 * visualization — system/track hierarchy, measure tree, marks,
 * compaction reports, attributions, and compaction counters all
 * line up.
 *
 * Times use a 1 µs tolerance because float math on the µs↔ms
 * boundary can drift by half a ULP. Everything else is deep-equal.
 */
function compareParsedTraces(
  a: ParsedTrace,
  b: ParsedTrace,
  opts: CompareOptions = {},
): void {
  expect(a.timeline.systems.length).toBe(b.timeline.systems.length)
  expect(approxEqual(a.timeline.start, b.timeline.start)).toBe(true)
  expect(approxEqual(a.timeline.end, b.timeline.end)).toBe(true)

  expect(a.metadata.compaction).toEqual(b.metadata.compaction)

  for (let i = 0; i < a.timeline.systems.length; i++) {
    compareSystems(a.timeline.systems[i], b.timeline.systems[i], opts)
  }
}

function compareSystems(a: System, b: System, opts: CompareOptions): void {
  if (opts.requireIds) expect(a.id).toBe(b.id)
  expect(a.name).toBe(b.name)
  expect(a.tracks.length).toBe(b.tracks.length)
  for (let i = 0; i < a.tracks.length; i++) {
    compareTracks(a.tracks[i], b.tracks[i], opts)
  }
}

function compareTracks(a: Track, b: Track, opts: CompareOptions): void {
  if (opts.requireIds) expect(a.id).toBe(b.id)
  expect(a.name).toBe(b.name)
  if (opts.requireTrackCategory) expect(a.category).toBe(b.category)
  compareContainers(a, b)
}

function compareContainers(
  a: {marks: Mark[]; measures: Measure[]},
  b: {marks: Mark[]; measures: Measure[]},
): void {
  expect(a.measures.length).toBe(b.measures.length)
  expect(a.marks.length).toBe(b.marks.length)

  // Marks may arrive in a different order between cycle 1 and cycle 2
  // because the export hoists every (nested + top-level) mark to the
  // track root. Sort by (time, name) before comparing so the test is
  // tolerant of this on cycle 1 → cycle 2 and exact on cycle 2 →
  // cycle 3 (where both inputs are pre-flattened).
  const aMarks = [...a.marks].sort(markCompare)
  const bMarks = [...b.marks].sort(markCompare)
  for (let i = 0; i < aMarks.length; i++) {
    expect(aMarks[i].name).toBe(bMarks[i].name)
    expect(aMarks[i].category).toBe(bMarks[i].category)
    expect(approxEqual(aMarks[i].time, bMarks[i].time)).toBe(true)
  }

  const aSorted = [...a.measures].sort(measureCompare)
  const bSorted = [...b.measures].sort(measureCompare)
  for (let i = 0; i < aSorted.length; i++) {
    compareMeasures(aSorted[i], bSorted[i])
  }
}

function compareMeasures(a: Measure, b: Measure): void {
  expect(a.name).toBe(b.name)
  expect(a.category).toBe(b.category)
  expect(approxEqual(a.start, b.start)).toBe(true)
  expect(approxEqual(a.end, b.end)).toBe(true)
  expect(a.color).toBe(b.color)
  expect(a.attribution).toEqual(b.attribution)
  expect(sortReports(a.compaction)).toEqual(sortReports(b.compaction))
  compareContainers(a, b)
}

function sortReports(reports: CompactionReport[] | undefined): CompactionReport[] | undefined {
  if (!reports) return reports
  return [...reports].sort((a, b) => {
    if (a.firstTs !== b.firstTs) return a.firstTs - b.firstTs
    if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1
    return 0
  })
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

/**
 * Drain a `ReadableStream<Uint8Array>` into a single concatenated
 * `Uint8Array`. Tests need this to compare cycle 2 → cycle 3 bytes
 * for byte-equality without buffering through Node's stream APIs.
 */
async function collectBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
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
 * Wrap raw bytes in a single-chunk `ReadableStream` so we can feed
 * them straight back into `parseTrace`.
 */
function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function exportThenParse(trace: ParsedTrace): Promise<{
  bytes: Uint8Array
  next: ParsedTrace
}> {
  const bytes = await collectBytes(zipCompactedTrace(trace))
  const next = await parseTrace(streamFromBytes(bytes), {
    name: SOURCE.name,
    size: bytes.byteLength,
  })
  return {bytes, next}
}

describe('zipCompactedTrace + parseTrace roundtrip', () => {
  it('suggests a clean filename regardless of source extension', () => {
    expect(suggestExportFilename({name: 'foo.json.gz', size: 0})).toBe(
      'foo.compacted.json.gz',
    )
    expect(suggestExportFilename({name: 'foo.json', size: 0})).toBe(
      'foo.compacted.json.gz',
    )
    expect(suggestExportFilename({name: 'foo', size: 0})).toBe(
      'foo.compacted.json.gz',
    )
    expect(suggestExportFilename({name: '', size: 0})).toBe(
      'trace.compacted.json.gz',
    )
  })

  // Regression: a previous implementation generated the entire JSON
  // body synchronously inside the ReadableStream's `start()` callback,
  // pushing one Uint8Array per measure into the controller's queue.
  // On real (~260K-measure) traces in Chrome this exceeded the source
  // stream's queue cap mid-loop, the controller errored, and the
  // CompressionStream silently emitted only the metadata-event
  // prefix — yielding a 451-byte gzip with zero `X` events.
  //
  // Lock the streaming contract that prevents that: chunks are
  // produced lazily one `pull` at a time, so on a trace large enough
  // to need many chunks we observe more than one read iteration AND
  // every measure round-trips through the export.
  it('streams JSON lazily across multiple pulls without buffering everything up front', async () => {
    const measureCount = 5000
    const traceEvents: Array<Record<string, unknown>> = [
      {ph: 'M', name: 'process_name', pid: 1, tid: 0, ts: 0, args: {name: 'P'}},
      {ph: 'M', name: 'thread_name', pid: 1, tid: 1, ts: 0, args: {name: 'Main'}},
    ]
    for (let i = 0; i < measureCount; i++) {
      traceEvents.push({
        ph: 'X',
        name: `evt-${i}`,
        cat: 'task',
        pid: 1,
        tid: 1,
        ts: i * 10,
        dur: 5,
      })
    }
    const trace = await parseTrace(
      stringStream(JSON.stringify({traceEvents})),
      SOURCE,
    )

    // Drain manually so we can count pulls. A fully-eager stream
    // would deliver everything in a single read; a lazy / pulled
    // stream produces several ~64 KiB chunks for a trace this size.
    const stream = streamCompactedJson(trace)
    const reader = stream.getReader()
    let reads = 0
    let totalBytes = 0
    while (true) {
      const {value, done} = await reader.read()
      if (done) break
      if (value) {
        reads += 1
        totalBytes += value.byteLength
      }
    }
    expect(reads).toBeGreaterThan(1)
    expect(totalBytes).toBeGreaterThan(measureCount * 30)

    // And the round-trip still recovers every X event — the
    // streaming refactor must not drop measures on the boundary.
    const {next} = await exportThenParse(trace)
    let parsedMeasures = 0
    for (const sys of next.timeline.systems) {
      for (const trk of sys.tracks) parsedMeasures += trk.measures.length
    }
    expect(parsedMeasures).toBe(measureCount)
  })

  // Regression: in the browser pipeline, the parser worker calls
  // `stripParsedTreeForTransfer` immediately before posting the trace
  // to the main thread. That helper empties every `track.measures` /
  // `Measure.measures` array (the recursive tree) because V8's
  // structured-clone serializer would otherwise blow its stack on
  // deep call graphs. The flat `track.buffers` SoA is what the main
  // thread renders from. An earlier export implementation walked the
  // recursive tree; once stripped, the tree contained zero entries
  // and the gzip held only the metadata-event prefix (a 451-byte
  // file). Lock that the export prefers `track.buffers` so a
  // post-strip trace still round-trips every measure.
  it('round-trips a stripped (worker-style) trace with zero measure-tree entries', async () => {
    const measureCount = 200
    const traceEvents: Array<Record<string, unknown>> = [
      {ph: 'M', name: 'process_name', pid: 1, tid: 0, ts: 0, args: {name: 'P'}},
      {ph: 'M', name: 'thread_name', pid: 1, tid: 1, ts: 0, args: {name: 'Main'}},
    ]
    let cursor = 0
    for (let i = 0; i < measureCount; i++) {
      traceEvents.push({
        ph: 'X',
        name: `evt-${i}`,
        cat: 'task',
        pid: 1,
        tid: 1,
        ts: cursor,
        dur: 50,
      })
      cursor += 100
    }
    traceEvents.push({
      ph: 'i',
      name: 'mark!',
      cat: 'sync',
      pid: 1,
      tid: 1,
      ts: 25,
      s: 'g',
    })
    const trace = await parseTrace(
      stringStream(JSON.stringify({traceEvents})),
      SOURCE,
    )

    // Simulate the worker → main-thread boundary. After this returns,
    // every `track.measures` is empty and every `Measure.measures` /
    // `Measure.marks` is empty; only `track.buffers` /
    // `track.markBuffers` carry the actual data.
    stripParsedTreeForTransfer(trace)
    for (const sys of trace.timeline.systems) {
      for (const trk of sys.tracks) {
        expect(trk.measures.length).toBe(0)
      }
    }

    const {next} = await exportThenParse(trace)
    let parsedMeasures = 0
    let parsedMarks = 0
    for (const sys of next.timeline.systems) {
      for (const trk of sys.tracks) {
        parsedMeasures += countMeasuresDeep(trk.measures)
        parsedMarks += countMarksDeep(trk.measures) + trk.marks.length
      }
    }
    expect(parsedMeasures).toBe(measureCount)
    expect(parsedMarks).toBeGreaterThanOrEqual(1)
  })

  it('emits valid JSON whose top-level shape matches the spec', async () => {
    const synth = JSON.stringify({
      traceEvents: [
        {ph: 'X', name: 'task', cat: 'test', pid: 1, tid: 1, ts: 0, dur: 100},
        {ph: 'X', name: 'child', cat: 'test', pid: 1, tid: 1, ts: 10, dur: 30},
      ],
    })
    const trace = await parseTrace(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(synth))
          c.close()
        },
      }),
      SOURCE,
    )

    const jsonBytes = await collectBytes(streamCompactedJson(trace))
    const text = new TextDecoder().decode(jsonBytes)
    const parsed = JSON.parse(text) as {
      traceEvents: unknown[]
      displayTimeUnit: string
      metadata: {_pfctoExport: {version: number; lossy: boolean}}
    }
    expect(parsed.displayTimeUnit).toBe('ms')
    expect(Array.isArray(parsed.traceEvents)).toBe(true)
    expect(parsed.metadata._pfctoExport.version).toBe(1)
    expect(parsed.metadata._pfctoExport.lossy).toBe(true)
  })

  it('roundtrips a measure tree with attribution and color (single cycle)', async () => {
    const raw = {
      traceEvents: [
        {
          ph: 'X',
          name: 'parent',
          cat: 'work',
          pid: 1,
          tid: 1,
          ts: 0,
          dur: 200,
        },
        {
          ph: 'X',
          name: 'child-a',
          cat: 'work',
          pid: 1,
          tid: 1,
          ts: 10,
          dur: 30,
          // Fed through args._pfctoColor so it's visible in the
          // re-imported tree.
          args: {_pfctoColor: '#ff0000'},
        },
        {
          ph: 'X',
          name: 'child-b',
          cat: 'work',
          pid: 1,
          tid: 1,
          ts: 60,
          dur: 80,
          args: {
            _pfctoAttr: {
              kind: 'callsite',
              source: 'test',
              label: 'doStuff',
              location: {url: 'a.js', lineNumber: 42},
            },
          },
        },
        {ph: 'i', name: 'mark!', cat: 'sync', pid: 1, tid: 1, ts: 50, s: 'g'},
      ],
    }
    const trace = await parseTrace(stringStream(JSON.stringify(raw)), SOURCE)
    const {next} = await exportThenParse(trace)
    compareParsedTraces(trace, next)
  })

  it('roundtrips synthetic CompactionReports (sibling, cpu-tiny, subpixel)', async () => {
    const fakeReports: CompactionReport[] = [
      {
        origin: 'sibling',
        category: 'work',
        names: ['leaf'],
        count: 12,
        firstTs: 0.05,
        lastTs: 0.5,
        totalDurationMs: 0.4,
      },
      {
        origin: 'cpu-tiny-frames',
        names: ['fnA', 'fnB'],
        count: 8,
        firstTs: 0.2,
        lastTs: 0.45,
        totalDurationMs: 0.2,
      },
      {
        origin: 'subpixel-subtree',
        names: ['root'],
        count: 50,
        firstTs: 1.0,
        lastTs: 1.05,
        totalDurationMs: 0.04,
        maxDepthFolded: 7,
        distinctNames: 3,
        nameDurationsMs: [0.02],
        subtreesMerged: 2,
      },
    ]
    const raw = {
      traceEvents: [
        {
          ph: 'X',
          name: 'compactedRun',
          cat: 'work',
          pid: 1,
          tid: 1,
          ts: 50,
          dur: 450,
          args: {_pfctoCompaction: fakeReports},
        },
      ],
    }
    const trace = await parseTrace(stringStream(JSON.stringify(raw)), SOURCE)

    // Confirm the parser actually picked up the synthetic reports
    // before we run the export — otherwise the roundtrip just
    // confirms two empty trees.
    const measure = trace.timeline.systems[0].tracks[0].measures[0]
    expect(measure.compaction).toBeDefined()
    expect(measure.compaction).toHaveLength(3)
    expect(trace.metadata.compaction?.subpixelMaxDepthFolded).toBe(7)

    const {next} = await exportThenParse(trace)
    compareParsedTraces(trace, next)
  })

  it('is idempotent across N=5 cycles on a synthetic fixture (byte-stable from cycle 2)', async () => {
    const raw = JSON.stringify(buildIdempotenceFixture())
    const original = await parseTrace(stringStream(raw), SOURCE)

    const traces: ParsedTrace[] = [original]
    const bytesPerCycle: Uint8Array[] = []
    let current = original
    for (let i = 0; i < 5; i++) {
      const {bytes, next} = await exportThenParse(current)
      bytesPerCycle.push(bytes)
      traces.push(next)
      current = next
    }

    // Cycle 1 → cycle 2 may shuffle ids/track categories (lossy
    // first export); cycle 2+ should be steady-state equal.
    for (let i = 1; i < traces.length - 1; i++) {
      compareParsedTraces(traces[i], traces[i + 1], {
        requireTrackCategory: true,
        requireIds: true,
      })
    }

    // Bytes must be identical from cycle 2 onward — the export sorts
    // children deterministically and uses a frozen export timestamp
    // for exactly this reason. Cycle 1's bytes may differ because
    // the source parse is intentionally lossy (compaction runs once).
    for (let i = 2; i < bytesPerCycle.length; i++) {
      expect(bytesPerCycle[i]).toEqual(bytesPerCycle[i - 1])
    }
  })

  it('roundtrips chrome-straddling-x.json.gz across 3 cycles', async () => {
    const fixturePath = path.join(
      __dirname,
      'fixtures',
      'chrome-straddling-x.json.gz',
    )
    const buffer = await readFile(fixturePath)
    const original = await parseTrace(
      streamFromBytes(new Uint8Array(buffer)),
      {name: 'chrome-straddling-x.json.gz', size: buffer.byteLength},
    )

    const traces: ParsedTrace[] = [original]
    const bytesPerCycle: Uint8Array[] = []
    let current = original
    for (let i = 0; i < 3; i++) {
      const {bytes, next} = await exportThenParse(current)
      bytesPerCycle.push(bytes)
      traces.push(next)
      current = next
    }

    for (let i = 1; i < traces.length - 1; i++) {
      compareParsedTraces(traces[i], traces[i + 1], {
        requireTrackCategory: true,
        requireIds: true,
      })
    }
    for (let i = 2; i < bytesPerCycle.length; i++) {
      expect(bytesPerCycle[i]).toEqual(bytesPerCycle[i - 1])
    }
  })

  it('roundtrips a generated trace (thousands of events) across 3 cycles', async () => {
    const {stream} = streamSyntheticTrace({
      eventCount: 4000,
      threadCount: 3,
      maxDepth: 4,
      shape: 'nested',
      sameNameRunLength: 64,
      asyncKeyCount: 4,
    })
    const original = await parseTrace(stream, {
      name: 'generated.json',
      size: 0,
    })

    const traces: ParsedTrace[] = [original]
    const bytesPerCycle: Uint8Array[] = []
    let current = original
    for (let i = 0; i < 3; i++) {
      const {bytes, next} = await exportThenParse(current)
      bytesPerCycle.push(bytes)
      traces.push(next)
      current = next
    }

    for (let i = 1; i < traces.length - 1; i++) {
      compareParsedTraces(traces[i], traces[i + 1], {
        requireTrackCategory: true,
        requireIds: true,
      })
    }
    for (let i = 2; i < bytesPerCycle.length; i++) {
      expect(bytesPerCycle[i]).toEqual(bytesPerCycle[i - 1])
    }
  })
})

describe('Metadata download button', () => {
  it('renders nothing when onDownload is omitted', () => {
    render(
      <Metadata
        source={{name: 'foo.json', size: 0}}
        onBack={() => {}}
      />,
    )
    expect(screen.queryByTestId('metadata-download-button')).toBeNull()
  })

  it('renders a Download button and disables it during the in-flight callback', async () => {
    let resolve!: () => void
    const onDownload = jest.fn(
      (): Promise<void> =>
        new Promise<void>(r => {
          resolve = r
        }),
    )
    render(
      <Metadata
        source={{name: 'foo.json', size: 0}}
        onBack={() => {}}
        onDownload={onDownload}
      />,
    )

    const button = screen.getByTestId('metadata-download-button') as HTMLButtonElement
    expect(button).not.toBeDisabled()
    expect(button.getAttribute('aria-label')).toMatch(/Download/i)

    fireEvent.click(button)
    expect(onDownload).toHaveBeenCalledTimes(1)
    expect(button).toBeDisabled()

    await act(async () => {
      resolve()
      await Promise.resolve()
    })
    expect(button).not.toBeDisabled()
  })
})

function countMeasuresDeep(measures: Measure[]): number {
  let n = 0
  for (const m of measures) {
    n += 1
    if (m.measures.length > 0) n += countMeasuresDeep(m.measures)
  }
  return n
}

function countMarksDeep(measures: Measure[]): number {
  let n = 0
  for (const m of measures) {
    n += m.marks.length
    if (m.measures.length > 0) n += countMarksDeep(m.measures)
  }
  return n
}

function stringStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Hand-built synthetic chrome trace covering the three fold origins
 * plus nested measures, marks, attribution, and a non-default color.
 * The fixture is small enough to stay readable but exercises every
 * `_pfcto*` arg the parser knows about.
 */
function buildIdempotenceFixture(): unknown {
  return {
    traceEvents: [
      {ph: 'M', name: 'process_name', pid: 1, tid: 0, ts: 0, args: {name: 'Renderer'}},
      {ph: 'M', name: 'thread_name', pid: 1, tid: 1, ts: 0, args: {name: 'Main'}},
      {
        ph: 'X',
        name: 'parent',
        cat: 'task',
        pid: 1,
        tid: 1,
        ts: 0,
        dur: 1000,
      },
      {
        ph: 'X',
        name: 'leaf-run',
        cat: 'task',
        pid: 1,
        tid: 1,
        ts: 5,
        dur: 100,
        args: {
          _pfctoCompaction: [
            {
              origin: 'sibling',
              category: 'task',
              names: ['leaf'],
              count: 16,
              firstTs: 0.005,
              lastTs: 0.105,
              totalDurationMs: 0.1,
            },
          ],
          _pfctoColor: '#abcdef',
        },
      },
      {
        ph: 'X',
        name: 'js-folded',
        cat: 'jsFrame',
        pid: 1,
        tid: 1,
        ts: 200,
        dur: 80,
        args: {
          _pfctoCompaction: [
            {
              origin: 'cpu-tiny-frames',
              names: ['fnA', 'fnB'],
              count: 12,
              firstTs: 0.2,
              lastTs: 0.28,
              totalDurationMs: 0.06,
            },
          ],
          _pfctoAttr: {
            kind: 'callsite',
            source: 'test',
            label: 'fnA',
            location: {url: 'a.js', lineNumber: 1},
          },
        },
      },
      {
        ph: 'X',
        name: 'subpixel-rep',
        cat: 'task',
        pid: 1,
        tid: 1,
        ts: 400,
        dur: 50,
        args: {
          _pfctoCompaction: [
            {
              origin: 'subpixel-subtree',
              names: ['rep'],
              count: 200,
              firstTs: 0.4,
              lastTs: 0.45,
              totalDurationMs: 0.05,
              maxDepthFolded: 12,
            },
          ],
        },
      },
      {ph: 'i', name: 'frame-start', cat: 'sync', pid: 1, tid: 1, ts: 50, s: 'g'},
      {ph: 'M', name: 'thread_name', pid: 1, tid: 2, ts: 0, args: {name: 'Worker'}},
      {ph: 'X', name: 'worker-task', cat: 'task', pid: 1, tid: 2, ts: 0, dur: 500},
    ],
    metadata: {origin: 'unit-test'},
  }
}
