import { useState } from 'react'
import type { System } from '../core'
import Track from './Track'

interface TimelineSystemProps {
  system: System
  timeToPercent: (t: number) => number
}

export default function TimelineSystem({ system, timeToPercent }: TimelineSystemProps) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="border-b border-[#2d3748]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 bg-[#1a202c] px-4 py-2 text-left text-sm font-semibold text-[#e2e8f0] hover:bg-[#232b3a]"
      >
        <span className="inline-block w-3 text-[#718096]">{expanded ? '▾' : '▸'}</span>
        <span>{system.name}</span>
        <span className="text-xs font-normal text-[#718096]">
          {system.tracks.length} track{system.tracks.length === 1 ? '' : 's'}
        </span>
      </button>
      {expanded && (
        <div className="flex flex-col">
          {system.tracks.map((track) => (
            <Track key={track.id} track={track} timeToPercent={timeToPercent} />
          ))}
        </div>
      )}
    </div>
  )
}
