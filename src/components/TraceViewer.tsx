import {useMemo} from 'react'
import type { ParsedTrace } from '../core'
import Aggregator from './Aggregator'
import Metadata from './Metadata'
import Timeline from './Timeline'
import {createSelectionStore} from './timeline/selectionStore'

interface TraceViewerProps {
  trace: ParsedTrace
  onBack: () => void
}

export default function TraceViewer({ trace, onBack }: TraceViewerProps) {
  // One selection store per trace mount, shared between the Timeline
  // (which owns the drag-selection UX + overlays) and the Aggregator
  // panel (which displays the committed range).
  const selectionStore = useMemo(() => createSelectionStore(), [trace])

  return (
    <div className="flex h-screen min-h-0 flex-col">
      <Metadata source={trace.source} onBack={onBack} />
      <Timeline timeline={trace.timeline} selectionStore={selectionStore} />
      <Aggregator selectionStore={selectionStore} />
    </div>
  )
}
