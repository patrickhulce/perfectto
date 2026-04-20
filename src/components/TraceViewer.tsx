import type { ParsedTrace } from '../core'
import Aggregator from './Aggregator'
import Metadata from './Metadata'
import Timeline from './Timeline'

interface TraceViewerProps {
  trace: ParsedTrace
  onBack: () => void
}

export default function TraceViewer({ trace, onBack }: TraceViewerProps) {
  return (
    <div className="flex h-screen min-h-0 flex-col">
      <Metadata source={trace.source} onBack={onBack} />
      <Timeline timeline={trace.timeline} />
      <Aggregator />
    </div>
  )
}
