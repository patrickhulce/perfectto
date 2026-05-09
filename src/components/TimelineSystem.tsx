import {memo} from 'react'
import CanvasTrackRenderer from './timeline/CanvasTrackRenderer'
import type {SystemLayout} from './Timeline'
import type {ViewportStore} from './timeline/viewportStore'
import type {SelectionStoreLike} from './timeline/selectionStore'
import type {ComparisonMatcher} from './timeline/comparisonMatcher'

interface TimelineSystemProps {
  layout: SystemLayout
  labelWidthPx: number
  viewportTopPx: number
  viewportBottomPx: number
  store: ViewportStore
  /**
   * Selection store, threaded straight through to every track canvas so
   * they can pick up the tree-highlight region for the hovered/selected
   * slice without re-rendering through React on every pointer move.
   */
  selectionStore: SelectionStoreLike
  comparisonMatcher?: ComparisonMatcher | null
  /** Number of tracks the active persona hid by default for this system. */
  hiddenTrackCount?: number
  /** Whether those hidden tracks are currently revealed. */
  hiddenTracksShown?: boolean
  onToggle: () => void
  onToggleTrack: (trackId: string) => void
  onToggleHidden?: () => void
}

function TimelineSystem({
  layout,
  labelWidthPx,
  viewportTopPx,
  viewportBottomPx,
  store,
  selectionStore,
  comparisonMatcher,
  hiddenTrackCount = 0,
  hiddenTracksShown = false,
  onToggle,
  onToggleTrack,
  onToggleHidden,
}: TimelineSystemProps) {
  const {system, topPx, headerHeightPx, heightPx, expanded, tracks} = layout

  return (
    <div
      className="absolute left-0 right-0 border-b border-[#2d3748]"
      style={{top: topPx, height: heightPx}}
    >
      <div
        className="absolute left-0 right-0 top-0 flex items-center bg-[#1a202c] text-left text-sm font-semibold text-[#e2e8f0]"
        // Matches the track label's z=3 so the system-header row also
        // tucks SelectionOverlay (z=1) behind its sticky left-gutter
        // label instead of letting the selection tint bleed onto it.
        style={{height: headerHeightPx, zIndex: 3}}
      >
        <button
          type="button"
          onClick={onToggle}
          data-no-pan
          className="sticky left-0 flex cursor-pointer items-center gap-2 px-4 py-2 hover:bg-[#232b3a]"
          style={{minWidth: labelWidthPx}}
        >
          <span className="inline-block w-3 text-[#718096]">{expanded ? '▾' : '▸'}</span>
          <span>{system.name}</span>
          <span className="text-xs font-normal text-[#718096]">
            {system.tracks.length} track{system.tracks.length === 1 ? '' : 's'}
          </span>
          {hiddenTrackCount > 0 && onToggleHidden && (
            <span
              role="button"
              tabIndex={0}
              data-no-pan
              aria-label={
                hiddenTracksShown
                  ? `Hide ${hiddenTrackCount} tracks`
                  : `Show ${hiddenTrackCount} hidden tracks`
              }
              onClick={e => {
                e.stopPropagation()
                onToggleHidden()
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  onToggleHidden()
                }
              }}
              className="ml-1 cursor-pointer rounded border border-[#2d3748] px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wider text-[#a0aec0] hover:border-[#667eea] hover:text-[#e2e8f0]"
            >
              {hiddenTracksShown ? `hide +${hiddenTrackCount}` : `+${hiddenTrackCount} hidden`}
            </span>
          )}
        </button>
      </div>
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
                selectionStore={selectionStore}
                comparisonMatcher={comparisonMatcher}
                expanded={tl.expanded}
                onToggle={tl.canExpand ? () => onToggleTrack(tl.track.id) : undefined}
              />
            </div>
          )
        })}
    </div>
  )
}

export default memo(TimelineSystem)
