import type {Measure, ParsedTrace, TimelineContainer, Track} from '../types'
import type {Matcher, MatchCandidate, MatchHeuristic, VicinityRule} from './types'

export const ABS_TOL_MS = 500
export const REL_TOL = 0.1
export const ROOT_REL_TOL = 0.2

const EPSILON_MS = 1e-9

interface MeasureContext {
  measure: Measure
  trackId: string
  depth: number
  root: Measure
  exactTreeKey: string
  shapeKey: string
  ordinalByName: number
  rootStart: number
  rootEnd: number
}

interface TraceIndex {
  byMeasure: Map<Measure, MeasureContext>
  byExactTree: Map<string, MeasureContext[]>
  byShape: Map<string, MeasureContext[]>
  byName: Map<string, MeasureContext[]>
  traceStart: number
  traceEnd: number
}

interface PathSegment {
  name: string
  namedOrdinal: number
  siblingOrdinal: number
}

export class SearchMatcher implements Matcher {
  private readonly source: TraceIndex
  private readonly target: TraceIndex
  private lastMeasure: Measure | null = null
  private lastTrackId: string | null = null
  private lastResult: MatchCandidate | null = null

  constructor(source: ParsedTrace, target: ParsedTrace) {
    this.source = buildTraceIndex(source)
    this.target = buildTraceIndex(target)
  }

  findMatch(measure: Measure, fromTrackId: string): MatchCandidate | null {
    if (this.lastMeasure === measure && this.lastTrackId === fromTrackId) {
      return this.lastResult
    }

    const sourceCtx = this.source.byMeasure.get(measure)
    if (!sourceCtx || sourceCtx.trackId !== fromTrackId) {
      this.remember(measure, fromTrackId, null)
      return null
    }

    const exact = this.firstVicinityMatch(
      sourceCtx,
      this.target.byExactTree.get(sourceCtx.exactTreeKey) ?? [],
      'exactTree',
    )
    if (exact) {
      this.remember(measure, fromTrackId, exact)
      return exact
    }

    const shape = this.bestShapeMatch(sourceCtx)
    if (shape) {
      this.remember(measure, fromTrackId, shape)
      return shape
    }

    const sameName = this.nameOnlyMatch(sourceCtx)
    this.remember(measure, fromTrackId, sameName)
    return sameName
  }

  private remember(
    measure: Measure,
    trackId: string,
    result: MatchCandidate | null,
  ): void {
    this.lastMeasure = measure
    this.lastTrackId = trackId
    this.lastResult = result
  }

  private bestShapeMatch(sourceCtx: MeasureContext): MatchCandidate | null {
    const candidates = this.target.byShape.get(sourceCtx.shapeKey) ?? []
    const ranked = [...candidates].sort(
      (a, b) => durationDelta(sourceCtx, a) - durationDelta(sourceCtx, b),
    )
    return this.firstVicinityMatch(sourceCtx, ranked, 'shapeWithDuration')
  }

  private nameOnlyMatch(sourceCtx: MeasureContext): MatchCandidate | null {
    const candidates = this.target.byName.get(sourceCtx.measure.name) ?? []
    const candidate = candidates[sourceCtx.ordinalByName]
    if (!candidate) return null
    return this.toCandidateIfNearby(sourceCtx, candidate, 'nameOnly')
  }

  private firstVicinityMatch(
    sourceCtx: MeasureContext,
    candidates: readonly MeasureContext[],
    heuristic: MatchHeuristic,
  ): MatchCandidate | null {
    for (const candidate of candidates) {
      const match = this.toCandidateIfNearby(sourceCtx, candidate, heuristic)
      if (match) return match
    }
    return null
  }

  private toCandidateIfNearby(
    sourceCtx: MeasureContext,
    targetCtx: MeasureContext,
    heuristic: MatchHeuristic,
  ): MatchCandidate | null {
    const vicinity = passesVicinity(this.source, sourceCtx, this.target, targetCtx)
    if (!vicinity) return null
    return {
      measure: targetCtx.measure,
      trackId: targetCtx.trackId,
      depth: targetCtx.depth,
      heuristic,
      vicinity,
    }
  }
}

function buildTraceIndex(trace: ParsedTrace): TraceIndex {
  const index: TraceIndex = {
    byMeasure: new Map(),
    byExactTree: new Map(),
    byShape: new Map(),
    byName: new Map(),
    traceStart: trace.timeline.start,
    traceEnd: trace.timeline.end,
  }
  const nameCounts = new Map<string, number>()

  for (const system of trace.timeline.systems) {
    for (const track of system.tracks) {
      walkContainer(index, nameCounts, track, track, [], null, 0)
    }
  }

  return index
}

function walkContainer(
  index: TraceIndex,
  nameCounts: Map<string, number>,
  track: Track,
  container: TimelineContainer,
  parentPath: readonly PathSegment[],
  root: Measure | null,
  depth: number,
): void {
  const namedSiblingCounts = new Map<string, number>()
  for (let i = 0; i < container.measures.length; i++) {
    const measure = container.measures[i]
    const namedOrdinal = namedSiblingCounts.get(measure.name) ?? 0
    namedSiblingCounts.set(measure.name, namedOrdinal + 1)

    const path = [
      ...parentPath,
      {name: measure.name, namedOrdinal, siblingOrdinal: i},
    ]
    const rootMeasure = root ?? measure
    const ordinalByName = nameCounts.get(measure.name) ?? 0
    nameCounts.set(measure.name, ordinalByName + 1)

    const ctx: MeasureContext = {
      measure,
      trackId: track.id,
      depth,
      root: rootMeasure,
      exactTreeKey: exactTreeKey(path),
      shapeKey: shapeKey(path),
      ordinalByName,
      rootStart: rootMeasure.start,
      rootEnd: rootMeasure.end,
    }
    index.byMeasure.set(measure, ctx)
    pushMap(index.byExactTree, ctx.exactTreeKey, ctx)
    pushMap(index.byShape, ctx.shapeKey, ctx)
    pushMap(index.byName, measure.name, ctx)

    walkContainer(index, nameCounts, track, measure, path, rootMeasure, depth + 1)
  }
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key)
  if (existing) {
    existing.push(value)
  } else {
    map.set(key, [value])
  }
}

function exactTreeKey(path: readonly PathSegment[]): string {
  return path.map(p => `${escapePart(p.name)}#${p.namedOrdinal}`).join('/')
}

function shapeKey(path: readonly PathSegment[]): string {
  return path.map(p => String(p.siblingOrdinal)).join('/')
}

function escapePart(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('/', '\\/')
}

function durationDelta(a: MeasureContext, b: MeasureContext): number {
  const aDur = Math.max(EPSILON_MS, a.measure.end - a.measure.start)
  const bDur = Math.max(EPSILON_MS, b.measure.end - b.measure.start)
  return Math.abs(Math.log(bDur / aDur))
}

function passesVicinity(
  sourceIndex: TraceIndex,
  source: MeasureContext,
  targetIndex: TraceIndex,
  target: MeasureContext,
): VicinityRule | null {
  if (Math.abs(target.measure.start - source.measure.start) <= ABS_TOL_MS) {
    return 'absolute'
  }

  const sourceTraceRel = relativePosition(
    source.measure.start,
    sourceIndex.traceStart,
    sourceIndex.traceEnd,
  )
  const targetTraceRel = relativePosition(
    target.measure.start,
    targetIndex.traceStart,
    targetIndex.traceEnd,
  )
  if (Math.abs(targetTraceRel - sourceTraceRel) <= REL_TOL) {
    return 'globalRelative'
  }

  if (source.root !== source.measure && target.root !== target.measure) {
    const sourceRootRel = relativePosition(
      source.measure.start,
      source.rootStart,
      source.rootEnd,
    )
    const targetRootRel = relativePosition(
      target.measure.start,
      target.rootStart,
      target.rootEnd,
    )
    if (Math.abs(targetRootRel - sourceRootRel) <= ROOT_REL_TOL) {
      return 'rootRelative'
    }
  }

  return null
}

function relativePosition(value: number, start: number, end: number): number {
  const span = end - start
  if (Math.abs(span) <= EPSILON_MS) return 0
  return (value - start) / span
}
