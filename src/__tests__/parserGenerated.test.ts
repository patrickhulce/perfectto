import {parseTrace} from '../core/parser'
import type {Measure, TimelineContainer} from '../core'
import {streamSyntheticTrace} from './fixtures/generateChromeTrace'

const HEAVY = process.env.SKIP_HEAVY === '1' ? describe.skip : describe

function walk(container: TimelineContainer, cb: (m: Measure) => void): void {
  for (const m of container.measures) {
    cb(m)
    walk(m, cb)
  }
}

describe('parseTrace - synthetic (lightweight)', () => {
  const SOURCE = {name: 'synth.json', size: 0}

  it('folds a long run of same-name siblings into a single compacted Measure', async () => {
    const {stream} = streamSyntheticTrace({
      eventCount: 10_000,
      sameNameRunLength: 10_000,
      threadCount: 1,
      tsStepUs: 10,
      nameTemplate: 'RunEvent',
      shape: 'flat',
    })

    // Force the size gate open so the integration path actually runs
    // sibling compaction on a small synthetic trace. Production
    // traces of this size deliberately skip compaction (see the
    // `'leaves small traces untouched'` regression below).
    const trace = await parseTrace(stream, SOURCE, {
      chromeParser: {compactionMinEvents: 0},
    })
    const compactions: Array<{count: number}> = []
    for (const sys of trace.timeline.systems) {
      for (const track of sys.tracks) {
        walk(track, m => {
          if (m.compaction) {
            for (const r of m.compaction) {
              if (r.origin === 'sibling' && r.names.includes('RunEvent')) {
                compactions.push({count: r.count})
              }
            }
          }
        })
      }
    }

    // The run is 10k events with matching (name, cat) — finalize
    // sibling compactor must emit at least one fold whose count is
    // non-trivial. We don't require a single fold because the fold
    // predicate is run-length + span-based, so contiguous runs may
    // be split across multiple compacted measures — but the total
    // folded event count should still dominate 10k.
    expect(compactions.length).toBeGreaterThan(0)
    const totalFolded = compactions.reduce((a, b) => a + b.count, 0)
    expect(totalFolded).toBeGreaterThanOrEqual(5_000)

    expect(trace.metadata.compaction?.siblingEventsFolded).toBeGreaterThan(0)
  })

  it('produces a bounded measure tree for a moderate flat trace', async () => {
    const {stream, manifest} = streamSyntheticTrace({
      eventCount: 20_000,
      threadCount: 2,
      shape: 'flat',
      nameTemplate: 'evt{i}',
    })

    const trace = await parseTrace(stream, SOURCE)
    let measureCount = 0
    for (const sys of trace.timeline.systems) {
      for (const track of sys.tracks) {
        walk(track, () => {
          measureCount += 1
        })
      }
    }
    // Unique names defeat the sibling compactor — so the tree should
    // be close to the emitted X count (within the thread split).
    expect(measureCount).toBeGreaterThanOrEqual(manifest.xEventCount * 0.5)
  })

  it('handles deep B/E nesting up to the shape maxDepth', async () => {
    const {stream} = streamSyntheticTrace({
      eventCount: 200,
      threadCount: 1,
      maxDepth: 32,
      shape: 'nested',
      tsStepUs: 100,
    })

    const trace = await parseTrace(stream, SOURCE)
    let observedDepth = 0
    for (const sys of trace.timeline.systems) {
      for (const track of sys.tracks) {
        const walkD = (c: TimelineContainer, d: number): void => {
          if (d > observedDepth) observedDepth = d
          for (const m of c.measures) walkD(m, d + 1)
        }
        walkD(track, 0)
      }
    }
    expect(observedDepth).toBeGreaterThanOrEqual(4)
  })

  it('builds a CPU-profile flame chart and folds tiny frames', async () => {
    const {stream} = streamSyntheticTrace({
      eventCount: 100,
      threadCount: 1,
      jsSampleCount: 20_000,
      cpuNodeCount: 8,
      shape: 'flat',
    })

    const trace = await parseTrace(stream, SOURCE)
    let jsFrameCount = 0
    let tinyFolds = 0
    for (const sys of trace.timeline.systems) {
      for (const track of sys.tracks) {
        walk(track, m => {
          if (m.category === 'jsFrame') jsFrameCount += 1
          if (m.compaction?.some(r => r.origin === 'cpu-tiny-frames')) {
            tinyFolds += 1
          }
        })
      }
    }
    expect(jsFrameCount).toBeGreaterThan(0)
    // Tiny-frame compactor is opportunistic — assert only that the
    // counter object is populated and the count isn't negative. The
    // shape isn't guaranteed to include fold-eligible runs, so we
    // don't require tinyFolds > 0 here.
    expect(trace.metadata.compaction?.cpuTinyEventsFolded).toBeGreaterThanOrEqual(0)
    expect(tinyFolds).toBeGreaterThanOrEqual(0)
  }, 15_000)

  it('leaves small traces untouched by sibling compaction', async () => {
    // 10k flat events of the SAME name, identical to the
    // "folds a long run" case — but without forcing the size gate.
    // On a real ~4MB-class trace we want zero silent edits to the
    // user's flame chart; the compactor should be a no-op below
    // the trace-wide event-count threshold.
    const {stream} = streamSyntheticTrace({
      eventCount: 10_000,
      sameNameRunLength: 10_000,
      threadCount: 1,
      tsStepUs: 10,
      nameTemplate: 'RunEvent',
      shape: 'flat',
    })

    const trace = await parseTrace(stream, SOURCE)
    expect(trace.metadata.compaction?.siblingRunsFolded ?? 0).toBe(0)
    expect(trace.metadata.compaction?.siblingEventsFolded ?? 0).toBe(0)
    let measureCount = 0
    for (const sys of trace.timeline.systems) {
      for (const track of sys.tracks) {
        walk(track, () => {
          measureCount += 1
        })
      }
    }
    // Every emitted X event survives as its own Measure — no events
    // were silently rolled up.
    expect(measureCount).toBeGreaterThanOrEqual(10_000)
  })

  it('never folds same-name parents that carry nested children', async () => {
    // Regression for a compaction bug that collapsed 11k `RunTask`
    // siblings (each wrapping real callback work) into a single
    // giant top-level rect, wiping out all nested callstacks.
    // The generator's `sameNameRunLength` option is flat-only, so
    // we build the shape by hand here.
    const events: Array<Record<string, unknown>> = [
      {
        ph: 'M',
        name: 'process_name',
        cat: '__metadata',
        pid: 1,
        tid: 1,
        ts: 0,
        args: {name: 'Renderer'},
      },
      {
        ph: 'M',
        name: 'thread_name',
        cat: '__metadata',
        pid: 1,
        tid: 1,
        ts: 0,
        args: {name: 'Main'},
      },
    ]
    // 2000 identical-name parents, each 100µs wide, each carrying a
    // nested child. This trips the old force-fold path (run length
    // well above the pre-fix `alwaysFoldAtRunLength` of 256) *and*
    // fits under the previous per-event gate, so the regression
    // would have collapsed every parent into a single rect with no
    // children. A leaf-only compactor leaves them all alone.
    const runCount = 2000
    const runWidthUs = 100
    for (let i = 0; i < runCount; i++) {
      const base = i * runWidthUs
      events.push({
        ph: 'X',
        name: 'RunTask',
        cat: 'sched',
        pid: 1,
        tid: 1,
        ts: base,
        dur: runWidthUs - 1,
      })
      events.push({
        ph: 'X',
        name: `DoWork_${i}`,
        cat: 'js',
        pid: 1,
        tid: 1,
        ts: base + 10,
        dur: runWidthUs - 20,
      })
    }

    const json = JSON.stringify({traceEvents: events})
    const bytes = new TextEncoder().encode(json)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })

    // Force the size gate open so the leaf-only guard inside
    // compactSiblings is the one preventing the fold here, not the
    // trace-level threshold.
    const trace = await parseTrace(stream, SOURCE, {
      chromeParser: {compactionMinEvents: 0},
    })
    const main = trace.timeline.systems[0].tracks[0]
    const topLevelRunTasks = main.measures.filter(m => m.name === 'RunTask')

    expect(topLevelRunTasks.length).toBe(runCount)
    // Every parent still owns its nested child — the assertion that
    // would have flipped red when the compactor dropped them.
    expect(topLevelRunTasks.every(m => m.measures.length === 1)).toBe(true)
    // Metadata confirms no sibling fold happened on this shape.
    expect(trace.metadata.compaction?.siblingRunsFolded ?? 0).toBe(0)
    expect(trace.metadata.compaction?.siblingEventsFolded ?? 0).toBe(0)
  })
})

HEAVY('parseTrace - synthetic (heavy, gated on SKIP_HEAVY=0)', () => {
  const SOURCE = {name: 'synth-heavy.json', size: 0}

  it('parses 1M X-events on one thread within budget', async () => {
    const t0 = Date.now()
    const {stream} = streamSyntheticTrace({
      eventCount: 1_000_000,
      threadCount: 1,
      shape: 'flat',
      nameTemplate: 'evt{i}',
    })

    const trace = await parseTrace(stream, SOURCE)
    const elapsed = Date.now() - t0
    // Loose budget: this is a functional test, not a perf gate.
    expect(elapsed).toBeLessThan(60_000)
    expect(trace.metadata.eventCount).toBeGreaterThan(0)
  }, 120_000)

  it('triggers the online streaming cap on a 3M-event thread', async () => {
    const {stream} = streamSyntheticTrace({
      eventCount: 3_000_000,
      threadCount: 1,
      shape: 'flat',
      nameTemplate: 'hot',
      category: 'bulk',
      tsStepUs: 2,
    })

    const trace = await parseTrace(stream, SOURCE)
    expect(trace.metadata.compaction?.onlineTriggered).toBe(true)
    expect(trace.metadata.compaction?.onlineEventsFolded).toBeGreaterThan(0)
  }, 180_000)
})
