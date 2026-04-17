import type { Timeline as TimelineModel } from '../core'
import TimelineSystem from './TimelineSystem'

interface TimelineProps {
  timeline: TimelineModel
}

export default function Timeline({ timeline }: TimelineProps) {
  const span = Math.max(timeline.end - timeline.start, 1)
  const timeToPercent = (t: number) => ((t - timeline.start) / span) * 100

  return (
    <div className="flex-1 overflow-auto">
      <div className="flex min-w-full flex-col">
        {timeline.systems.map((system) => (
          <TimelineSystem key={system.id} system={system} timeToPercent={timeToPercent} />
        ))}
      </div>
    </div>
  )
}
