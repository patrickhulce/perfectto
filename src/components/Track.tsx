import {memo} from 'react'
import type {Mark, Measure, TimelineContainer, Track as TrackModel} from '../core'
import {lowerBoundByStart, lowerBoundByTime} from './timeline/binarySearch'
import {ROW_HEIGHT} from './timeline/trackLayout'

interface TrackProps {
  track: TrackModel
  timelineStartMs: number
  pxPerMs: number
  labelWidthPx: number
  /** Deferred visible window (in ms). Used for binary-search culling. */
  visibleStartMs: number
  visibleEndMs: number
  heightPx: number
  /**
   * When false, recursion stops at depth 1 — i.e. the track still shows a
   * single row of its direct children, but grandchildren and below are
   * hidden. Defaults to true (fully expanded) so existing callers keep
   * working.
   */
  expanded?: boolean
  onToggle?: () => void
}

/**
 * Measures narrower than this get skipped entirely — and so do their children.
 * At a 1px cutoff, the invisible subtree gives zero useful pixels but costs
 * potentially thousands of DOM nodes, so pruning it saves huge amounts of work.
 */
const MIN_MEASURE_PX = 1

function Track({
  track,
  timelineStartMs,
  pxPerMs,
  labelWidthPx,
  visibleStartMs,
  visibleEndMs,
  heightPx,
  expanded = true,
  onToggle,
}: TrackProps) {
  const maxDepth = expanded ? Number.POSITIVE_INFINITY : 1
  const canToggle = !!onToggle
  return (
    <div
      className="relative border-b border-[#1a202c] bg-[#11151d]"
      style={{height: heightPx, width: '100%'}}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!canToggle}
        data-no-pan
        className={
          'flex items-start gap-1 border-r border-[#2d3748] bg-[#11151d] px-2 py-2 text-left text-xs text-[#a0aec0]' +
          (canToggle ? ' cursor-pointer hover:bg-[#151b25]' : ' cursor-default')
        }
        style={{
          position: 'sticky',
          left: 0,
          top: 0,
          zIndex: 1,
          width: labelWidthPx,
          height: heightPx,
        }}
      >
        <span
          aria-hidden
          className="mt-px inline-block w-3 shrink-0 text-[#718096]"
        >
          {canToggle ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-[#cbd5e0]">{track.name}</span>
          {track.category && (
            <span className="block truncate text-[10px] uppercase tracking-wide text-[#718096]">
              {track.category}
            </span>
          )}
        </span>
      </button>
      {/*
        Content layer sits to the right of the sticky label and owns the
        scaleX/translateX transform driven by zoom gestures. Measures/marks
        inside position themselves relative to the layer (i.e. they do NOT
        add `labelWidthPx` to their leftPx). Keeping the transform off the
        label keeps the label crisp while a pinch is live.

        We deliberately do NOT set `will-change: transform` here. Promoting
        this element to its own compositor layer means the browser
        rasterizes its contents once at 1x and then stretches the raster
        when --zoom-scale changes. The counter-scaled measure text would
        get baked into that raster at 1/s and then upscaled by s, yielding
        blurry bitmap-stretched glyphs. Without promotion, Chrome repaints
        on every transform change, so text re-rasterizes crisply at the
        current effective scale.
      */}
      <div
        data-testid="track-content-layer"
        className="absolute inset-y-0"
        style={{
          left: labelWidthPx,
          right: 0,
          transform:
            'translateX(var(--zoom-translate, 0px)) scaleX(var(--zoom-scale, 1))',
          transformOrigin: '0 0',
        }}
      >
        <ContainerContents
          container={track}
          timelineStartMs={timelineStartMs}
          pxPerMs={pxPerMs}
          visibleStartMs={visibleStartMs}
          visibleEndMs={visibleEndMs}
          depth={0}
          maxDepth={maxDepth}
        />
      </div>
    </div>
  )
}

export default memo(Track)

interface ContainerContentsProps {
  container: TimelineContainer
  timelineStartMs: number
  pxPerMs: number
  visibleStartMs: number
  visibleEndMs: number
  depth: number
  maxDepth: number
}

function ContainerContents({
  container,
  timelineStartMs,
  pxPerMs,
  visibleStartMs,
  visibleEndMs,
  depth,
  maxDepth,
}: ContainerContentsProps) {
  if (depth >= maxDepth) return null
  const {measures, marks} = container
  const nodes: React.ReactNode[] = []

  // ------- Measures: binary search + iterate until past the viewport. -------
  // measures are sorted by `start` asc during parse finalize.
  const firstIdx = measures.length
    ? Math.max(0, lowerBoundByStart(measures, visibleStartMs) - 1)
    : 0

  for (let i = firstIdx; i < measures.length; i++) {
    const m = measures[i]
    if (m.start > visibleEndMs) break
    if (m.end < visibleStartMs) continue
    // maxEnd lets us prune whole subtrees that are technically ordered
    // before the viewport but whose children live even further behind.
    const subtreeEnd = m.maxEnd !== undefined ? Math.max(m.end, m.maxEnd) : m.end
    if (subtreeEnd < visibleStartMs) continue

    const widthPx = (m.end - m.start) * pxPerMs
    if (widthPx <= MIN_MEASURE_PX) continue // skip the measure AND its subtree

    nodes.push(
      <MeasureView
        key={m.id}
        measure={m}
        timelineStartMs={timelineStartMs}
        pxPerMs={pxPerMs}
        visibleStartMs={visibleStartMs}
        visibleEndMs={visibleEndMs}
        depth={depth}
        maxDepth={maxDepth}
      />,
    )
  }

  // ------- Marks: same lower-bound idea. -------
  const firstMarkIdx = marks.length ? lowerBoundByTime(marks, visibleStartMs) : 0
  for (let i = firstMarkIdx; i < marks.length; i++) {
    const mk = marks[i]
    if (mk.time > visibleEndMs) break
    nodes.push(
      <MarkView
        key={mk.id}
        mark={mk}
        timelineStartMs={timelineStartMs}
        pxPerMs={pxPerMs}
        depth={depth}
      />,
    )
  }

  return <>{nodes}</>
}

interface MeasureViewProps {
  measure: Measure
  timelineStartMs: number
  pxPerMs: number
  visibleStartMs: number
  visibleEndMs: number
  depth: number
  maxDepth: number
}

function MeasureView({
  measure,
  timelineStartMs,
  pxPerMs,
  visibleStartMs,
  visibleEndMs,
  depth,
  maxDepth,
}: MeasureViewProps) {
  const leftPx = (measure.start - timelineStartMs) * pxPerMs
  const rawWidthPx = (measure.end - measure.start) * pxPerMs
  const widthPx = Math.max(rawWidthPx, 1)

  return (
    <>
      <div
        title={`${measure.name} (${measure.start.toFixed(1)}–${measure.end.toFixed(1)} ms)`}
        className="absolute left-0 top-0 overflow-hidden rounded-sm border border-black/30 px-1 text-[11px] leading-[18px] text-white/90 shadow-sm"
        style={{
          transform: `translateX(${leftPx}px) translateY(${depth * ROW_HEIGHT + 4}px)`,
          width: widthPx,
          height: ROW_HEIGHT - 4,
          backgroundColor: measure.color ?? '#4a5568',
        }}
      >
        {/*
          The parent's scaleX stretches everything inside — including letters.
          We counter-scale the text span by `--zoom-inv-scale` (= 1/scale)
          with a left-edge origin so glyphs stay at their natural pixel size
          while the colored bar underneath continues to scale cleanly. At
          rest `--zoom-inv-scale` is 1 so this collapses to the previous
          rendering.
        */}
        <span
          className="block truncate"
          style={{
            transform: 'scaleX(var(--zoom-inv-scale, 1))',
            transformOrigin: '0 50%',
          }}
        >
          {measure.name}
        </span>
      </div>
      <ContainerContents
        container={measure}
        timelineStartMs={timelineStartMs}
        pxPerMs={pxPerMs}
        visibleStartMs={visibleStartMs}
        visibleEndMs={visibleEndMs}
        depth={depth + 1}
        maxDepth={maxDepth}
      />
    </>
  )
}

interface MarkViewProps {
  mark: Mark
  timelineStartMs: number
  pxPerMs: number
  depth: number
}

function MarkView({mark, timelineStartMs, pxPerMs, depth}: MarkViewProps) {
  const leftPx = (mark.time - timelineStartMs) * pxPerMs
  return (
    <div
      title={`${mark.name} @ ${mark.time.toFixed(1)} ms`}
      className="absolute left-0 top-0 flex items-start"
      style={{
        transform: `translateX(${leftPx - 1}px) translateY(${depth * ROW_HEIGHT + 2}px)`,
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
