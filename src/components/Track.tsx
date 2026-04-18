import type {Mark, Measure, TimelineContainer, Track as TrackModel} from '../core'
import {lowerBoundByStart, lowerBoundByTime} from './timeline/binarySearch'
import {ROW_HEIGHT} from './timeline/trackLayout'
import type {Viewport} from './timeline/useTimelineViewport'

interface TrackProps {
  track: TrackModel
  viewport: Viewport
  heightPx: number
  labelWidthPx: number
}

/**
 * Measures narrower than this get skipped entirely — and so do their children.
 * At a 1px cutoff, the invisible subtree gives zero useful pixels but costs
 * potentially thousands of DOM nodes, so pruning it saves huge amounts of work.
 */
const MIN_MEASURE_PX = 1

export default function Track({track, viewport, heightPx, labelWidthPx}: TrackProps) {
  return (
    <div
      className="flex border-b border-[#1a202c] bg-[#11151d]"
      style={{height: heightPx}}
    >
      <div
        className="shrink-0 border-r border-[#2d3748] px-3 py-2 text-xs text-[#a0aec0]"
        style={{width: labelWidthPx}}
      >
        <div className="truncate font-medium text-[#cbd5e0]">{track.name}</div>
        {track.category && (
          <div className="truncate text-[10px] uppercase tracking-wide text-[#718096]">
            {track.category}
          </div>
        )}
      </div>
      <div className="relative flex-1 overflow-hidden">
        <ContainerContents container={track} viewport={viewport} depth={0} />
      </div>
    </div>
  )
}

interface ContainerContentsProps {
  container: TimelineContainer
  viewport: Viewport
  depth: number
}

function ContainerContents({container, viewport, depth}: ContainerContentsProps) {
  const {measures, marks} = container
  const nodes: React.ReactNode[] = []

  // ------- Measures: binary search + iterate until past the viewport. -------
  // measures are sorted by `start` asc during parse finalize.
  const firstIdx = measures.length
    ? Math.max(0, lowerBoundByStart(measures, viewport.startMs) - 1)
    : 0

  for (let i = firstIdx; i < measures.length; i++) {
    const m = measures[i]
    if (m.start > viewport.endMs) break
    if (m.end < viewport.startMs) continue
    // maxEnd lets us prune whole subtrees that are technically ordered
    // before the viewport but whose children live even further behind.
    const subtreeEnd = m.maxEnd !== undefined ? Math.max(m.end, m.maxEnd) : m.end
    if (subtreeEnd < viewport.startMs) continue

    const widthPx = (m.end - m.start) * viewport.pxPerMs
    if (widthPx <= MIN_MEASURE_PX) continue // skip the measure AND its subtree

    nodes.push(<MeasureView key={m.id} measure={m} viewport={viewport} depth={depth} />)
  }

  // ------- Marks: same lower-bound idea. -------
  const firstMarkIdx = marks.length ? lowerBoundByTime(marks, viewport.startMs) : 0
  for (let i = firstMarkIdx; i < marks.length; i++) {
    const mk = marks[i]
    if (mk.time > viewport.endMs) break
    nodes.push(<MarkView key={mk.id} mark={mk} viewport={viewport} depth={depth} />)
  }

  return <>{nodes}</>
}

interface MeasureViewProps {
  measure: Measure
  viewport: Viewport
  depth: number
}

function MeasureView({measure, viewport, depth}: MeasureViewProps) {
  const leftPx = viewport.timeToPx(measure.start)
  const rawWidthPx = (measure.end - measure.start) * viewport.pxPerMs
  const widthPx = Math.max(rawWidthPx, 1)

  return (
    <>
      <div
        title={`${measure.name} (${measure.start.toFixed(1)}–${measure.end.toFixed(1)} ms)`}
        className="absolute overflow-hidden rounded-sm border border-black/30 px-1 text-[11px] leading-[18px] text-white/90 shadow-sm"
        style={{
          transform: `translateX(${leftPx}px)`,
          width: widthPx,
          top: depth * ROW_HEIGHT + 4,
          height: ROW_HEIGHT - 4,
          backgroundColor: measure.color ?? '#4a5568',
        }}
      >
        <span className="truncate">{measure.name}</span>
      </div>
      <ContainerContents container={measure} viewport={viewport} depth={depth + 1} />
    </>
  )
}

interface MarkViewProps {
  mark: Mark
  viewport: Viewport
  depth: number
}

function MarkView({mark, viewport, depth}: MarkViewProps) {
  const leftPx = viewport.timeToPx(mark.time)
  return (
    <div
      title={`${mark.name} @ ${mark.time.toFixed(1)} ms`}
      className="absolute flex items-start"
      style={{
        transform: `translateX(${leftPx - 1}px)`,
        top: depth * ROW_HEIGHT + 2,
        height: ROW_HEIGHT,
      }}
    >
      <div
        className="h-full w-[2px]"
        style={{backgroundColor: mark.color ?? '#ed8936'}}
      />
    </div>
  )
}
