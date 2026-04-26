import type {CompactionReport, Measure, TimelineContainer} from '../types'
import type {CompactionCounters} from './compaction'

/**
 * Knobs for the highest-point subpixel-subtree cull. Defaults aim for
 * "fold any subtree whose root is already too short to render usefully,
 * regardless of how deep it goes". This is the only finalize-phase pass
 * that handles the depth dimension — once a parent's duration drops
 * below the threshold we stop recursing entirely, so a 0.01 ms span
 * can never carry a 1400-deep skeleton underneath it.
 *
 * The pass is depth-agnostic *by design*: a deep stack made of all
 * visible-duration frames stays intact (the user can still drill in);
 * a shallow stack made of sub-pixel frames also stays intact (each
 * frame is still individually clickable). The cull only fires when
 * collapsing the whole subtree is genuinely lossless from a rendering
 * standpoint.
 */
export interface SubpixelCullOptions {
  /**
   * Maximum measure duration in ms that triggers a cull. Anything
   * `<= maxFoldDurMs` becomes a cull candidate. Default 0.05 ms (50 µs)
   * — about a fifth of a pixel at fit-zoom on a 60-second trace, well
   * below the threshold where individual frames can be told apart.
   */
  maxFoldDurMs: number
  /**
   * Minimum descendant count required before a cull fires. Skips the
   * cull on small leaf-only subtrees where the wrapping report would
   * cost more memory than it saves; the existing sibling/CPU-tiny
   * compactors handle those.
   */
  minDescendants: number
}

export const DEFAULT_SUBPIXEL_CULL_OPTIONS: SubpixelCullOptions = {
  maxFoldDurMs: 0.05,
  minDescendants: 1,
}

/**
 * Replace any Measure subtree whose root duration is `<= maxFoldDurMs`
 * with a single representative carrying a `'subpixel-subtree'`
 * compaction report summarising the descendants. Operates top-down
 * (pre-order) so we cull at the highest possible point — once we
 * replace a subtree, we never descend into the replaced node.
 *
 * Implemented as an iterative worklist over containers rather than
 * recursion: the trees we hit on big traces can be 1000+ deep, well
 * past the point where a recursive walk is safe under V8's default
 * stack budget (~10k frames, less when the fn is inlined).
 *
 * Mutates `container.measures` arrays in place. Updates the shared
 * {@link CompactionCounters} so the parser can surface aggregate
 * "N events folded" stats on `metadata.compaction`.
 */
/**
 * Tick threshold for {@link cullSubpixelSubtrees} / sibling / cpu-tiny
 * compactors. Each helper accepts an `onProgress(deltaEvents)` callback
 * and flushes the running tally at this interval so the parser's
 * outer `eventsProcessed` counter advances smoothly during finalize
 * instead of jumping in (track × pass)-sized chunks. 4096 is roughly a
 * frame's worth of work on a million-event track — small enough to
 * keep the bar moving, large enough that the throttle in the parser's
 * 50ms `emitFinalizeProgress` debounce coalesces ticks into a handful
 * of progress events per pass.
 */
export const PROGRESS_TICK_MEASURES = 4096

export function cullSubpixelSubtrees(
  container: TimelineContainer,
  opts: SubpixelCullOptions,
  mintId: () => string,
  counters: CompactionCounters,
  onProgress?: (deltaEvents: number) => void,
): void {
  const queue: TimelineContainer[] = [container]
  let pending = 0
  const flush = (): void => {
    if (pending > 0 && onProgress) onProgress(pending)
    pending = 0
  }
  while (queue.length > 0) {
    const c = queue.pop()!
    const measures = c.measures
    let changed = false
    let foldsInserted = 0
    const out: Measure[] = []
    for (let i = 0; i < measures.length; i++) {
      const m = measures[i]
      const dur = m.end - m.start
      if (dur <= opts.maxFoldDurMs) {
        const folded = foldSubtree(m, mintId, counters, opts)
        if (folded) {
          out.push(folded)
          changed = true
          foldsInserted += 1
          // The fold collapsed root + descendants into one node; account
          // for every original Measure it covered so the progress bar
          // tracks "events scanned" not "nodes left after cull".
          pending += 1 + (folded.compaction?.[0].count ?? 0)
          if (pending >= PROGRESS_TICK_MEASURES) flush()
          continue
        }
      }
      // Above threshold (or below threshold but too few descendants to
      // bother folding) — descend so we still catch sub-pixel pockets
      // deeper down.
      out.push(m)
      pending += 1
      if (pending >= PROGRESS_TICK_MEASURES) flush()
      if (m.measures.length > 0) queue.push(m)
    }
    if (changed) {
      // Multiple subtree folds in the same parent are the visual
      // failure mode the user spotted: each fold paints as a 0.02ms
      // sliver, so the parent looks empty even though we just folded
      // thousands of events. Sort by start (the input order isn't
      // guaranteed sorted at cull time — finalizeContainer runs after)
      // and coalesce any run of consecutive subpixel-subtree folds
      // into one wide blanket representative spanning their combined
      // extent.
      if (foldsInserted >= 2) {
        out.sort(compareByStart)
        c.measures = coalesceSubpixelFolds(out, mintId)
      } else {
        c.measures = out
      }
    }
  }
  flush()
}

function compareByStart(a: Measure, b: Measure): number {
  if (a.start !== b.start) return a.start - b.start
  return b.end - a.end
}

function isSubpixelFold(m: Measure): boolean {
  if (!m.compaction || m.compaction.length === 0) return false
  return m.compaction[0].origin === 'subpixel-subtree'
}

/**
 * Walk a sorted-by-start `arr` and merge any run of two-or-more
 * adjacent subpixel-subtree fold representatives into a single wide
 * representative. The merge:
 *
 * - Spans `[run[0].start, run[last].end]`, so a parent with thousands
 *   of subpixel folds renders as one striped block instead of a
 *   forest of invisible 0.02ms slivers.
 * - Aggregates per-name durations from each contributing fold's
 *   `nameDurationsMs` and surfaces the top {@link NAMES_PREVIEW_CAP}
 *   names by total time. This is what the user sees in tooltips
 *   when they want to know "what was hidden here".
 * - Carries `count = sum_over_folds(1 + r.count) - 1`. The `-1` is
 *   load-bearing: the merged rep counts as `1` event in the
 *   `eventsRepresented` invariant (every Measure does), and the rest
 *   of the source events live in `count`. This keeps the
 *   `Σ (1 + count) === source events` invariant intact across the
 *   merge.
 *
 * Single-fold runs pass through untouched — there's nothing to
 * coalesce, and the original rep already carries a meaningful
 * subtree-specific name and bounds.
 */
function coalesceSubpixelFolds(
  arr: Measure[],
  mintId: () => string,
): Measure[] {
  const out: Measure[] = []
  let i = 0
  while (i < arr.length) {
    if (!isSubpixelFold(arr[i])) {
      out.push(arr[i])
      i += 1
      continue
    }
    let j = i + 1
    while (j < arr.length && isSubpixelFold(arr[j])) j += 1
    const runLen = j - i
    if (runLen < 2) {
      out.push(arr[i])
      i = j
      continue
    }
    out.push(mergeFoldRun(arr, i, j, mintId))
    i = j
  }
  return out
}

function mergeFoldRun(
  arr: Measure[],
  lo: number,
  hi: number,
  mintId: () => string,
): Measure {
  const head = arr[lo]
  const last = arr[hi - 1]
  let totalSourceEvents = 0
  let totalDur = 0
  let maxDepth = 0
  let distinctSum = 0
  const nameDur = new Map<string, number>()

  for (let k = lo; k < hi; k++) {
    const r = arr[k].compaction![0]
    // `count` excludes the surviving rep itself by construction; +1
    // restores the rep so we add up genuine source-event totals.
    totalSourceEvents += 1 + r.count
    totalDur += r.totalDurationMs
    if (r.maxDepthFolded !== undefined && r.maxDepthFolded > maxDepth) {
      maxDepth = r.maxDepthFolded
    }
    if (r.distinctNames !== undefined) distinctSum += r.distinctNames
    const names = r.names ?? []
    const durs = r.nameDurationsMs
    for (let n = 0; n < names.length; n++) {
      const nm = names[n]
      const d = durs && n < durs.length ? durs[n] : 0
      nameDur.set(nm, (nameDur.get(nm) ?? 0) + d)
    }
  }

  const sortedByDur = [...nameDur.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })
  const preview = sortedByDur.slice(0, NAMES_PREVIEW_CAP)

  const subtreesMerged = hi - lo
  const report: CompactionReport = {
    origin: 'subpixel-subtree',
    category: head.category,
    names: preview.map(([n]) => n),
    nameDurationsMs: preview.map(([, d]) => d),
    // See doc above mergeFoldRun: keeps `1 + count === totalSourceEvents`
    // so the eventsRepresented invariant test holds across blanket merges.
    count: totalSourceEvents - 1,
    firstTs: head.start,
    lastTs: last.end,
    totalDurationMs: totalDur,
    maxDepthFolded: maxDepth,
    // distinctNames is informational; summing across folds is an upper
    // bound (folds may share names) but never undercounts, which is
    // the right side to err on for "how much detail was hidden".
    distinctNames: distinctSum,
    subtreesMerged,
  }

  return {
    id: mintId(),
    name: `${subtreesMerged} folded subtrees`,
    start: head.start,
    end: last.end,
    category: head.category,
    color: head.color,
    events: [],
    marks: [],
    measures: [],
    compaction: [report],
  }
}

/**
 * Walk every descendant of `root` (root included) and produce the
 * representative Measure that replaces the subtree. Returns `null`
 * when the subtree is small enough that the cull's `minDescendants`
 * gate keeps the original tree intact — caller falls through to the
 * recurse branch in that case so child-level compactors still get a
 * chance.
 */
/**
 * Cap the human-readable name preview at a small handful so a 1400-frame
 * distinct-name explosion doesn't bloat the structured-clone payload.
 * Shared between the per-subtree fold and the blanket-merge step so
 * both report shapes stay budget-comparable.
 */
const NAMES_PREVIEW_CAP = 8

function foldSubtree(
  root: Measure,
  mintId: () => string,
  counters: CompactionCounters,
  opts: SubpixelCullOptions,
): Measure | null {
  let descendantCount = 0
  let maxDepth = 0
  let totalDurMs = 0
  // name → aggregate node duration. Keeping per-name totals (instead
  // of just a Set) lets the blanket-merge step downstream rank the
  // most prominent inner names by time spent rather than alphabetical
  // happenstance.
  const nameDur = new Map<string, number>()

  // Iterative pre-order walk using an explicit stack of {measure,
  // depth} entries. The trees we hit on big traces are routinely
  // 1000+ deep — a recursive walk blows the JS stack on V8.
  const stack: Array<{m: Measure; depth: number}> = [{m: root, depth: 0}]
  while (stack.length > 0) {
    const {m, depth} = stack.pop()!
    if (depth > maxDepth) maxDepth = depth
    const dur = m.end - m.start
    nameDur.set(m.name, (nameDur.get(m.name) ?? 0) + dur)
    if (depth > 0) {
      // Don't double-count the root itself in `descendantCount` /
      // `totalDurMs` — its name still contributes to `nameDur` so the
      // representative carries it, but the count semantically reflects
      // "how many *more* events does this fold represent".
      descendantCount += 1
      totalDurMs += dur
    }
    const kids = m.measures
    for (let i = 0; i < kids.length; i++) {
      stack.push({m: kids[i], depth: depth + 1})
    }
  }

  if (descendantCount < opts.minDescendants) return null

  counters.subpixelSubtreesFolded += 1
  counters.subpixelEventsFolded += descendantCount
  if (maxDepth > counters.subpixelMaxDepthFolded) {
    counters.subpixelMaxDepthFolded = maxDepth
  }

  // Sort by duration desc, tie-break by name asc for determinism.
  const sortedByDur = [...nameDur.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
  })
  const preview = sortedByDur.slice(0, NAMES_PREVIEW_CAP)

  return {
    id: mintId(),
    name: root.name,
    start: root.start,
    end: root.end,
    category: root.category,
    color: root.color,
    events: [],
    marks: [],
    measures: [],
    compaction: [
      {
        origin: 'subpixel-subtree',
        category: root.category,
        names: preview.map(([n]) => n),
        nameDurationsMs: preview.map(([, d]) => d),
        count: descendantCount,
        firstTs: root.start,
        lastTs: root.end,
        totalDurationMs: totalDurMs,
        maxDepthFolded: maxDepth,
        distinctNames: nameDur.size,
      },
    ],
  }
}
