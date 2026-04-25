import type {Measure, TimelineContainer} from '../types'
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
export function cullSubpixelSubtrees(
  container: TimelineContainer,
  opts: SubpixelCullOptions,
  mintId: () => string,
  counters: CompactionCounters,
): void {
  const queue: TimelineContainer[] = [container]
  while (queue.length > 0) {
    const c = queue.pop()!
    const measures = c.measures
    let changed = false
    const out: Measure[] = []
    for (let i = 0; i < measures.length; i++) {
      const m = measures[i]
      const dur = m.end - m.start
      if (dur <= opts.maxFoldDurMs) {
        const folded = foldSubtree(m, mintId, counters, opts)
        if (folded) {
          out.push(folded)
          changed = true
          continue
        }
      }
      // Above threshold (or below threshold but too few descendants to
      // bother folding) — descend so we still catch sub-pixel pockets
      // deeper down.
      out.push(m)
      if (m.measures.length > 0) queue.push(m)
    }
    if (changed) c.measures = out
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
function foldSubtree(
  root: Measure,
  mintId: () => string,
  counters: CompactionCounters,
  opts: SubpixelCullOptions,
): Measure | null {
  let descendantCount = 0
  let maxDepth = 0
  let totalDurMs = 0
  const names = new Set<string>()

  // Iterative pre-order walk using an explicit stack of {measure,
  // depth} entries. The trees we hit on big traces are routinely
  // 1000+ deep — a recursive walk blows the JS stack on V8.
  const stack: Array<{m: Measure; depth: number}> = [{m: root, depth: 0}]
  while (stack.length > 0) {
    const {m, depth} = stack.pop()!
    if (depth > maxDepth) maxDepth = depth
    if (depth > 0) {
      // Don't double-count the root itself in `descendantCount` /
      // `totalDurMs` — its name still goes into the names set so the
      // representative carries it, but the count semantically reflects
      // "how many *more* events does this fold represent".
      descendantCount += 1
      totalDurMs += m.end - m.start
    }
    names.add(m.name)
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

  const sortedNames = [...names].sort()
  // Cap the human-readable preview at a small handful so a 1400-frame
  // distinct-name explosion doesn't bloat the structured-clone payload.
  const NAMES_PREVIEW_CAP = 8
  const preview =
    sortedNames.length <= NAMES_PREVIEW_CAP
      ? sortedNames
      : sortedNames.slice(0, NAMES_PREVIEW_CAP)

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
        names: preview,
        count: descendantCount,
        firstTs: root.start,
        lastTs: root.end,
        totalDurationMs: totalDurMs,
        maxDepthFolded: maxDepth,
        distinctNames: sortedNames.length,
      },
    ],
  }
}
