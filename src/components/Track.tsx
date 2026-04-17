import type { Mark, Measure, TimelineContainer, Track as TrackModel } from '../core'

interface TrackProps {
  track: TrackModel
  timeToPercent: (t: number) => number
}

const ROW_HEIGHT = 22

export default function Track({ track, timeToPercent }: TrackProps) {
  const depth = containerDepth(track)
  const height = Math.max(depth, 1) * ROW_HEIGHT + 8

  return (
    <div className="flex border-b border-[#1a202c] bg-[#11151d]">
      <div className="w-48 shrink-0 border-r border-[#2d3748] px-3 py-2 text-xs text-[#a0aec0]">
        <div className="truncate font-medium text-[#cbd5e0]">{track.name}</div>
        {track.category && (
          <div className="truncate text-[10px] uppercase tracking-wide text-[#718096]">
            {track.category}
          </div>
        )}
      </div>
      <div className="relative flex-1" style={{ height }}>
        <ContainerContents
          container={track}
          timeToPercent={timeToPercent}
          depth={0}
        />
      </div>
    </div>
  )
}

interface ContainerContentsProps {
  container: TimelineContainer
  timeToPercent: (t: number) => number
  depth: number
}

function ContainerContents({ container, timeToPercent, depth }: ContainerContentsProps) {
  return (
    <>
      {container.measures.map((measure) => (
        <MeasureView
          key={measure.id}
          measure={measure}
          timeToPercent={timeToPercent}
          depth={depth}
        />
      ))}
      {container.marks.map((mark) => (
        <MarkView key={mark.id} mark={mark} timeToPercent={timeToPercent} depth={depth} />
      ))}
    </>
  )
}

interface MeasureViewProps {
  measure: Measure
  timeToPercent: (t: number) => number
  depth: number
}

function MeasureView({ measure, timeToPercent, depth }: MeasureViewProps) {
  const left = timeToPercent(measure.start)
  const width = Math.max(timeToPercent(measure.end) - left, 0.1)

  return (
    <>
      <div
        title={`${measure.name} (${measure.start.toFixed(1)}–${measure.end.toFixed(1)} ms)`}
        className="absolute overflow-hidden rounded-sm border border-black/30 px-1 text-[11px] leading-[18px] text-white/90 shadow-sm"
        style={{
          left: `${left}%`,
          width: `${width}%`,
          top: depth * ROW_HEIGHT + 4,
          height: ROW_HEIGHT - 4,
          backgroundColor: measure.color ?? '#4a5568',
        }}
      >
        <span className="truncate">{measure.name}</span>
      </div>
      <ContainerContents
        container={measure}
        timeToPercent={timeToPercent}
        depth={depth + 1}
      />
    </>
  )
}

interface MarkViewProps {
  mark: Mark
  timeToPercent: (t: number) => number
  depth: number
}

function MarkView({ mark, timeToPercent, depth }: MarkViewProps) {
  const left = timeToPercent(mark.time)
  return (
    <div
      title={`${mark.name} @ ${mark.time.toFixed(1)} ms`}
      className="absolute flex items-start"
      style={{
        left: `${left}%`,
        top: depth * ROW_HEIGHT + 2,
        height: ROW_HEIGHT,
        transform: 'translateX(-1px)',
      }}
    >
      <div
        className="h-full w-[2px]"
        style={{ backgroundColor: mark.color ?? '#ed8936' }}
      />
    </div>
  )
}

function containerDepth(container: TimelineContainer): number {
  let max = 0
  for (const measure of container.measures) {
    const childDepth = 1 + containerDepth(measure)
    if (childDepth > max) max = childDepth
  }
  if (container.marks.length > 0 && max === 0) max = 1
  return max
}
