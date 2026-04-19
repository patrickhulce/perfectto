import {memo} from 'react'
import CanvasTrackRenderer from './timeline/CanvasTrackRenderer'
import type {SystemLayout} from './Timeline'
import type {ViewportStore} from './timeline/viewportStore'

interface TimelineSystemProps {
  layout: SystemLayout
  labelWidthPx: number
  viewportTopPx: number
  viewportBottomPx: number
  store: ViewportStore
  onToggle: () => void
  onToggleTrack: (trackId: string) => void
}

function TimelineSystem({
  layout,
  labelWidthPx,
  viewportTopPx,
  viewportBottomPx,
  store,
  onToggle,
  onToggleTrack,
}: TimelineSystemProps) {
  const {system, topPx, headerHeightPx, heightPx, expanded, tracks} = layout

  return (
    <div
      className="absolute left-0 right-0 border-b border-[#2d3748]"
      style={{top: topPx, height: heightPx}}
    >
      <button
        type="button"
        onClick={onToggle}
        data-no-pan
        className="absolute left-0 right-0 top-0 flex cursor-pointer items-center bg-[#1a202c] text-left text-sm font-semibold text-[#e2e8f0] hover:bg-[#232b3a]"
        style={{height: headerHeightPx, zIndex: 2}}
      >
        <span
          className="sticky left-0 flex items-center gap-2 px-4 py-2"
          style={{minWidth: labelWidthPx}}
        >
          <span className="inline-block w-3 text-[#718096]">{expanded ? '▾' : '▸'}</span>
          <span>{system.name}</span>
          <span className="text-xs font-normal text-[#718096]">
            {system.tracks.length} track{system.tracks.length === 1 ? '' : 's'}
          </span>
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
              <CanvasTrackRenderer
                track={tl.track}
                heightPx={tl.heightPx}
                labelWidthPx={labelWidthPx}
                store={store}
                expanded={tl.expanded}
                onToggle={() => onToggleTrack(tl.track.id)}
              />
            </div>
          )
        })}
    </div>
  )
}

export default memo(TimelineSystem)
