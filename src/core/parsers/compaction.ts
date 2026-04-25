import type {
  CompactionReport,
  Measure,
  TimelineContainer,
} from '../types'

/**
 * Knobs for the finalize-time sibling compactor. Defaults aim for
 * "fold obvious sampler/tight-loop bursts aggressively, never touch
 * structural parents".
 *
 * The compactor exists to trim sub-visible leaf clutter — rows of 10k
 * identical 10µs tasks that paint as a single smear on the flame chart.
 * It must never fold parents that hold nested work; doing so silently
 * deletes everything inside and the user loses the ability to drill in.
 */
export interface SiblingCompactionOptions {
  /**
   * Minimum run length (inclusive) before we collapse. At 8 the
   * compactor leaves plausible-looking short bursts alone but still
   * catches the thousands-of-identical-events patterns that dominate
   * big traces.
   */
  minRunLength: number
  /**
   * Only fold a run whose aggregate span is below `maxRunSpanMs` _or_
   * below `maxFractionOfParent × parent.span`. Either predicate passing
   * is enough — the wall-time budget catches runs on enormous traces
   * whose fraction stays small; the fraction budget catches short
   * traces whose absolute ms are tiny.
   */
  maxRunSpanMs: number
  maxFractionOfParent: number
  /**
   * Per-event duration cap, in ms. If any single member of a candidate
   * run is wider than this the run is _not_ folded — a 250ms `RunTask`
   * sitting next to another 250ms `RunTask` is visually meaningful and
   * each carries its own callstack, so we keep them.
   */
  maxEventDurMs: number
  /**
   * Override: leaf-only runs at or beyond this length always fold,
   * regardless of wall-time span or parent fraction. Lets us catch
   * sampler bursts that span the whole track without lowering the span
   * gate to the point where legitimate structural runs get swallowed.
   * Still obeys {@link maxEventDurMs} and leaf-only — it only relaxes
   * the span check.
   */
  alwaysFoldAtRunLength: number
}

export const DEFAULT_SIBLING_COMPACTION_OPTIONS: SiblingCompactionOptions = {
  minRunLength: 8,
  maxRunSpanMs: 1.0,
  maxFractionOfParent: 0.01,
  maxEventDurMs: 0.5,
  alwaysFoldAtRunLength: 1024,
}

/**
 * Accumulator used to roll counters up through a recursive fold pass.
 * The same shape is reused across sibling + CPU-tiny passes so the
 * parser can flatten both into a single `CompactionMetadata`.
 */
export interface CompactionCounters {
  siblingRunsFolded: number
  siblingEventsFolded: number
  cpuTinyRunsFolded: number
  cpuTinyEventsFolded: number
  /** Subtrees collapsed by `cullSubpixelSubtrees`. */
  subpixelSubtreesFolded: number
  /** Total descendants absorbed by subpixel-subtree culls. */
  subpixelEventsFolded: number
  /** Deepest subtree any single cull operation collapsed. */
  subpixelMaxDepthFolded: number
}

export function emptyCompactionCounters(): CompactionCounters {
  return {
    siblingRunsFolded: 0,
    siblingEventsFolded: 0,
    cpuTinyRunsFolded: 0,
    cpuTinyEventsFolded: 0,
    subpixelSubtreesFolded: 0,
    subpixelEventsFolded: 0,
    subpixelMaxDepthFolded: 0,
  }
}

/**
 * Collapse runs of adjacent same-`(category, name)` sibling Measures
 * into a single compacted Measure carrying a {@link CompactionReport}.
 * Recurses into children first so deeper runs are folded before the
 * enclosing parent considers its siblings — nested compaction stays
 * bottom-up.
 *
 * Invariants assumed on input:
 *   - `container.measures` is already sorted by `start` (the caller runs
 *     `finalizeContainer` first).
 *   - Parent/child bounds are well-formed (every child ⊆ its parent).
 *
 * The compacted Measure takes the run's total span `[firstStart,
 * lastEnd]` and reuses the first folded measure's `category` (they all
 * match by construction). Its `id` is stamped by `mintId()` so
 * downstream SliceBuffers still have a unique key per Measure.
 */
export function compactSiblings(
  container: TimelineContainer,
  opts: SiblingCompactionOptions,
  mintId: () => string,
  counters: CompactionCounters,
  parentSpanMs?: number,
): void {
  // Recurse first: fold inside every child, then consider this container
  // for its own sibling-level fold. Bottom-up keeps us from accidentally
  // re-scanning content we just collapsed.
  for (const child of container.measures) {
    const childSpan = child.end - child.start
    compactSiblings(child, opts, mintId, counters, childSpan)
  }

  const measures = container.measures
  if (measures.length < opts.minRunLength) return

  const out: Measure[] = []
  let i = 0
  while (i < measures.length) {
    const head = measures[i]
    let j = i + 1
    // Extend the run while the next sibling matches (name + category),
    // has zero children (leaf-only — folding a structural parent would
    // silently delete its subtree), and has a sub-visible duration.
    // Abutting is fine; gaps are allowed as long as the aggregate span
    // predicate downstream still passes.
    const headLeaf =
      head.measures.length === 0 && head.end - head.start <= opts.maxEventDurMs
    if (headLeaf) {
      while (
        j < measures.length &&
        measures[j].name === head.name &&
        measures[j].category === head.category &&
        measures[j].measures.length === 0 &&
        measures[j].end - measures[j].start <= opts.maxEventDurMs
      ) {
        j++
      }
    }
    const runLength = j - i
    if (!headLeaf || runLength < opts.minRunLength) {
      for (let k = i; k < j; k++) out.push(measures[k])
      i = j
      continue
    }

    const firstStart = head.start
    let lastEnd = head.end
    let totalDur = head.end - head.start
    for (let k = i + 1; k < j; k++) {
      const m = measures[k]
      if (m.end > lastEnd) lastEnd = m.end
      totalDur += m.end - m.start
    }
    const runSpan = lastEnd - firstStart

    // Size-gate the fold: either the run is long enough that we relax
    // the span check (catches sampler-explosion patterns that span the
    // whole track), stays within the absolute wall-time budget, or is a
    // tiny fraction of its parent. Failing all three keeps the fold from
    // swallowing a visually-meaningful span. Leaf-only + per-event
    // duration caps are enforced above; this is purely a "is this run
    // sub-pixel-ish?" gate.
    const forceFold = runLength >= opts.alwaysFoldAtRunLength
    const fractionOk =
      forceFold ||
      (parentSpanMs === undefined || parentSpanMs <= 0
        ? runSpan <= opts.maxRunSpanMs
        : runSpan <= Math.max(opts.maxRunSpanMs, parentSpanMs * opts.maxFractionOfParent))
    if (!fractionOk) {
      for (let k = i; k < j; k++) out.push(measures[k])
      i = j
      continue
    }

    const report: CompactionReport = {
      origin: 'sibling',
      category: head.category,
      names: [head.name],
      count: runLength,
      firstTs: firstStart,
      lastTs: lastEnd,
      totalDurationMs: totalDur,
    }

    const folded: Measure = {
      id: mintId(),
      name: head.name,
      start: firstStart,
      end: lastEnd,
      category: head.category,
      color: head.color,
      events: [],
      marks: [],
      measures: [],
      compaction: [report],
    }

    out.push(folded)
    counters.siblingRunsFolded += 1
    counters.siblingEventsFolded += runLength
    i = j
  }

  if (out.length !== measures.length) {
    container.measures = out
  }
}

/**
 * Knobs for the CPU-profile tiny-frame compactor. Applied only to
 * measures the parser tagged with `category === 'jsFrame'`.
 */
export interface CpuTinyCompactionOptions {
  /**
   * Don't fold a run of fewer than this many children, even if they're
   * all tiny. Avoids noise on short profiles.
   */
  minRunLength: number
  /** Threshold below which a child frame's duration is considered "tiny", in ms. */
  tinyFrameMs: number
}

export const DEFAULT_CPU_TINY_OPTIONS: CpuTinyCompactionOptions = {
  minRunLength: 16,
  tinyFrameMs: 0.25,
}

/**
 * Walks a measure subtree whose root is a synthesized V8 JS frame tree
 * (`category === 'jsFrame'`) and folds runs of adjacent sub-
 * `tinyFrameMs` children into a single compacted Measure per run.
 * Non-JS children are passed through untouched.
 *
 * Rationale: real V8 sampler output can emit thousands of sub-ms
 * leaf frames under a single `flushPassiveEffects` or `render` root.
 * Each one renders as a singleton in the flame chart even though they
 * collectively communicate "there was churn here, but nothing wider
 * than a pixel". The compactor collapses those runs into a single
 * density rect the user can click to see the fold's metadata.
 */
export function compactCpuTinyFrames(
  root: Measure,
  opts: CpuTinyCompactionOptions,
  mintId: () => string,
  counters: CompactionCounters,
): void {
  if (root.category !== 'jsFrame') return

  const walk = (m: Measure): void => {
    for (const c of m.measures) walk(c)
    foldTinyChildren(m, opts, mintId, counters)
  }
  walk(root)
}

function foldTinyChildren(
  parent: Measure,
  opts: CpuTinyCompactionOptions,
  mintId: () => string,
  counters: CompactionCounters,
): void {
  const kids = parent.measures
  if (kids.length < opts.minRunLength) return

  const out: Measure[] = []
  let i = 0
  while (i < kids.length) {
    if (!isTinyJsFrame(kids[i], opts)) {
      out.push(kids[i])
      i++
      continue
    }
    // Greedy run of contiguous tiny jsFrame siblings. Non-tiny or non-
    // jsFrame children break the run — they presumably carry structure
    // the user will want to see.
    let j = i + 1
    while (j < kids.length && isTinyJsFrame(kids[j], opts)) j++

    const runLength = j - i
    if (runLength < opts.minRunLength) {
      for (let k = i; k < j; k++) out.push(kids[k])
      i = j
      continue
    }

    const head = kids[i]
    const last = kids[j - 1]
    const names = collectNames(kids, i, j)
    let totalDur = 0
    for (let k = i; k < j; k++) totalDur += kids[k].end - kids[k].start

    const report: CompactionReport = {
      origin: 'cpu-tiny-frames',
      category: 'jsFrame',
      names,
      count: runLength,
      firstTs: head.start,
      lastTs: last.end,
      totalDurationMs: totalDur,
    }

    out.push({
      id: mintId(),
      name: names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`,
      start: head.start,
      end: last.end,
      category: 'jsFrame',
      color: head.color,
      events: [],
      marks: [],
      measures: [],
      compaction: [report],
    })
    counters.cpuTinyRunsFolded += 1
    counters.cpuTinyEventsFolded += runLength
    i = j
  }

  if (out.length !== kids.length) {
    parent.measures = out
  }
}

function isTinyJsFrame(m: Measure, opts: CpuTinyCompactionOptions): boolean {
  if (m.category !== 'jsFrame') return false
  // Leaf-only: a jsFrame that already carries children represents real
  // observed structure. Bottom-up traversal means any descendants that
  // _were_ tiny got their own fold pass first, so reaching here with
  // `measures.length > 0` means we'd be discarding visible content.
  if (m.measures.length > 0) return false
  return m.end - m.start < opts.tinyFrameMs
}

function collectNames(kids: Measure[], start: number, end: number): string[] {
  const seen = new Set<string>()
  for (let k = start; k < end; k++) seen.add(kids[k].name)
  const out = [...seen]
  out.sort()
  return out
}
