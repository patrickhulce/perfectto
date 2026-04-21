import {useMemo, useState} from 'react'
import {
  applyPersona,
  BUILTIN_PERSONAS,
  detectPersona,
  findPersona,
  type ParsedTrace,
} from '../core'
import Aggregator from './Aggregator'
import Metadata from './Metadata'
import Timeline from './Timeline'
import {createSelectionStore} from './timeline/selectionStore'

interface TraceViewerProps {
  trace: ParsedTrace
  onBack: () => void
}

export default function TraceViewer({trace, onBack}: TraceViewerProps) {
  // One selection store per trace mount, shared between the Timeline
  // (which owns the drag-selection UX + overlays) and the Aggregator
  // panel (which displays the committed range).
  const selectionStore = useMemo(() => createSelectionStore(), [trace])

  // Auto-detect the best persona for this trace on first mount. Users
  // can override via the picker; we keep the detected id around so the
  // picker can tag it with "(auto)".
  const detectedPersona = useMemo(() => detectPersona(trace), [trace])
  const [activePersonaId, setActivePersonaId] = useState(detectedPersona.id)

  // Apply the active persona to the trace. Side effect: repaints every
  // track's color buffers (structure untouched). Keyed on the trace
  // identity and persona id so switching personas recomputes once.
  const appliedPersona = useMemo(() => {
    const persona = findPersona(activePersonaId) ?? detectedPersona
    return applyPersona(trace, persona)
  }, [trace, activePersonaId, detectedPersona])

  return (
    <div className="flex h-screen min-h-0 flex-col">
      <Metadata
        source={trace.source}
        onBack={onBack}
        personas={BUILTIN_PERSONAS}
        activePersonaId={appliedPersona.persona.id}
        detectedPersonaId={detectedPersona.id}
        onPersonaChange={setActivePersonaId}
      />
      <Timeline
        timeline={trace.timeline}
        selectionStore={selectionStore}
        appliedPersona={appliedPersona}
      />
      <Aggregator selectionStore={selectionStore} />
    </div>
  )
}
