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
import {
  createInputBindingsStore,
  type InputBindingsStore,
} from './timeline/inputBindingsStore'
import {
  parseTimelineUrlParams,
  resolveInitialSelection,
  type InitialView,
} from './timeline/urlParams'

/**
 * Input-binding settings are app-wide (a user's preferred matrix
 * shouldn't reset when they load a new trace), so the store lives at
 * module scope and hydrates from localStorage once on first import.
 */
let sharedInputBindingsStore: InputBindingsStore | null = null
function getBindingsStore(): InputBindingsStore {
  if (sharedInputBindingsStore === null) {
    sharedInputBindingsStore = createInputBindingsStore()
  }
  return sharedInputBindingsStore
}

interface TraceViewerProps {
  trace: ParsedTrace
  onBack: () => void
}

export default function TraceViewer({trace, onBack}: TraceViewerProps) {
  // One selection store per trace mount, shared between the Timeline
  // (which owns the drag-selection UX + overlays) and the Aggregator
  // panel (which displays the committed range).
  const selectionStore = useMemo(() => createSelectionStore(), [trace])

  // Parse deep-link URL parameters (`?view[...]&selection[...]`) once
  // per trace load. `view` is applied by the Timeline's zoom hook; the
  // slice lookup for `selection` happens here so we only have to walk
  // the track buffers a single time per mount. See `urlParams.ts` for
  // the supported query syntax — this is primarily a debugging
  // affordance so a bug report URL can pin a precise viewport +
  // highlight state.
  const initial: {view: InitialView | null; initialSelectedSlice:
    ReturnType<typeof resolveInitialSelection>} = useMemo(() => {
    if (typeof window === 'undefined') {
      return {view: null, initialSelectedSlice: null}
    }
    const parsed = parseTimelineUrlParams(window.location.search)
    const initialSelectedSlice = parsed.selection
      ? resolveInitialSelection(trace.timeline, parsed.selection)
      : null
    return {view: parsed.view, initialSelectedSlice}
  }, [trace])

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

  const bindingsStore = getBindingsStore()

  return (
    <div className="flex h-screen min-h-0 flex-col">
      <Metadata
        source={trace.source}
        onBack={onBack}
        personas={BUILTIN_PERSONAS}
        activePersonaId={appliedPersona.persona.id}
        detectedPersonaId={detectedPersona.id}
        onPersonaChange={setActivePersonaId}
        bindingsStore={bindingsStore}
      />
      <Timeline
        timeline={trace.timeline}
        selectionStore={selectionStore}
        appliedPersona={appliedPersona}
        bindingsStore={bindingsStore}
        initialView={initial.view}
        initialSelectedSlice={initial.initialSelectedSlice}
      />
      <Aggregator selectionStore={selectionStore} />
    </div>
  )
}
