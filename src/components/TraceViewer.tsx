import {useMemo, useState} from 'react'
import {
  applyProfile,
  BUILTIN_PROFILES,
  detectProfile,
  findProfile,
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

  // Auto-detect the best profile for this trace on first mount. Users
  // can override via the picker; we keep the detected id around so the
  // picker can tag it with "(auto)".
  const detectedProfile = useMemo(() => detectProfile(trace), [trace])
  const [activeProfileId, setActiveProfileId] = useState(detectedProfile.id)

  // Apply the active profile to the trace. Side effect: repaints every
  // track's color buffers (structure untouched). Keyed on the trace
  // identity and profile id so switching profiles recomputes once.
  const appliedProfile = useMemo(() => {
    const profile = findProfile(activeProfileId) ?? detectedProfile
    return applyProfile(trace, profile)
  }, [trace, activeProfileId, detectedProfile])

  return (
    <div className="flex h-screen min-h-0 flex-col">
      <Metadata
        source={trace.source}
        onBack={onBack}
        profiles={BUILTIN_PROFILES}
        activeProfileId={appliedProfile.profile.id}
        detectedProfileId={detectedProfile.id}
        onProfileChange={setActiveProfileId}
      />
      <Timeline
        timeline={trace.timeline}
        selectionStore={selectionStore}
        appliedProfile={appliedProfile}
      />
      <Aggregator selectionStore={selectionStore} />
    </div>
  )
}
