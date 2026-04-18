import Track from './Track'
import {LABEL_WIDTH_PX, type SystemLayout} from './Timeline'
import type {Viewport} from './timeline/useTimelineViewport'

interface TimelineSystemProps {
  layout: SystemLayout
  viewport: Viewport
  viewportTopPx: number
  viewportBottomPx: number
  onToggle: () => void
}

export default function TimelineSystem({
  layout,
  viewport,
  viewportTopPx,
  viewportBottomPx,
  onToggle,
}: TimelineSystemProps) {
  const {system, topPx, headerHeightPx, expanded, tracks} = layout

  return (
    <div
      className="absolute left-0 right-0 border-b border-[#2d3748]"
      style={{top: topPx}}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-2 bg-[#1a202c] px-4 py-2 text-left text-sm font-semibold text-[#e2e8f0] hover:bg-[#232b3a]"
        style={{height: headerHeightPx}}
      >
        <span className="inline-block w-3 text-[#718096]">{expanded ? '▾' : '▸'}</span>
        <span>{system.name}</span>
        <span className="text-xs font-normal text-[#718096]">
          {system.tracks.length} track{system.tracks.length === 1 ? '' : 's'}
        </span>
      </button>
      {expanded &&
        tracks.map(tl => {
          if (tl.topPx + tl.heightPx <= viewportTopPx) return null
          if (tl.topPx >= viewportBottomPx) return null
          return (
            <div
              key={tl.track.id}
              className="absolute left-0 right-0"
              style={{top: tl.topPx - topPx, height: tl.heightPx}}
            >
              <Track
                track={tl.track}
                viewport={viewport}
                heightPx={tl.heightPx}
                labelWidthPx={LABEL_WIDTH_PX}
              />
            </div>
          )
        })}
    </div>
  )
}
