import {useCallback, useMemo} from 'react'
import {
  applyPersona,
  detectPersona,
  findPersona,
  type ParseProgress,
  type ParsedTrace,
} from '../core'
import {
  suggestExportFilename,
  zipCompactedTrace,
} from '../core/export/zipCompactedTrace'
import TracePaneHeader from './TracePaneHeader'
import Timeline from './Timeline'
import {
  TIMELINE_OVERVIEW_HEIGHT_COMPACT_PX,
  TIMELINE_OVERVIEW_HEIGHT_PX,
} from './timeline/TimelineOverview'
import ParseProgressView from './ParseProgressView'
import ParseErrorView, {type ParseErrorState} from './ParseErrorView'
import {triggerDownload} from './downloadTrace'
import {
  createPaneSelectionView,
  type SelectionStore,
} from './timeline/selectionStore'
import type {InputBindingsStore} from './timeline/inputBindingsStore'
import type {HoveredPaneStore} from './timeline/hoveredPaneStore'
import {
  parseTimelineUrlParams,
  resolveInitialSelection,
  type InitialView,
} from './timeline/urlParams'

/**
 * Per-pane snapshot of the loading / loaded state. Lives in {@link App}
 * and is plumbed through here so the pane renders one of the three
 * possible bodies (parsing → progress, errored → error card, loaded →
 * TracePaneHeader + Timeline).
 */
export interface ParsingState {
  name: string
  /**
   * Denominator for the progress bar. For gzipped inputs this is the
   * uncompressed payload size (read from the ISIZE trailer at load
   * time); for plain files it's the file size.
   */
  bytesTotal: number
  progress: ParseProgress
  startedAt: number
  controller: AbortController
}

export interface TracePaneProps {
  /** Stable pane id. Threaded into stores so highlights/keybinds scope correctly. */
  paneId: string
  /** Loaded trace, when parsing has completed. Null while parsing or errored. */
  trace: ParsedTrace | null
  /** In-flight parse state. Renders the progress view when set. */
  parsing: ParsingState | null
  /** Last parse failure for this pane, if any. Renders the error card when set. */
  parseError: ParseErrorState | null
  /**
   * App-level global stores threaded through to the Timeline. The pane
   * wraps `selectionStore` in a `PaneSelectionView` so deeper
   * components see only this pane's selection state.
   */
  selectionStore: SelectionStore
  bindingsStore: InputBindingsStore
  hoveredPaneStore: HoveredPaneStore
  /**
   * Active persona id (global across panes). Each pane runs
   * auto-detection against its own trace and applies the persona
   * locally. Null when no trace has loaded anywhere yet.
   */
  activePersonaId: string | null
  /**
   * `true` for whichever pane was the first to ever display a trace in
   * this App session. Only the first pane consumes URL deep-link
   * params (`?view=...&selection=...`); other panes ignore them so a
   * second drop doesn't fight the first pane for the URL viewport.
   */
  consumeUrlParams: boolean
  /** Aborts the in-flight parse for this pane. Wires the progress-view Cancel button. */
  onCancelParse: () => void
  /** Dismisses the parse error card and returns this pane to splash-of-pane state. */
  onDismissError: () => void
  /** Removes this pane entirely. Wires the close button in the TracePaneHeader. */
  onClose: () => void
  /**
   * When `true`, the Timeline renders the shorter overview band
   * variant (~36 px instead of 56). Set by App when N≥2 so two
   * stacked panes don't double up on chrome.
   */
  compactOverview?: boolean
}

/**
 * One trace's worth of UI. Owns nothing global — every store and
 * persona-related piece of state lives in {@link App}; this component
 * just composes the three possible body states on top of those.
 *
 * Replaces the old `TraceViewer` component, which assumed exactly one
 * trace at a time. The split exists so the App can stack multiple
 * panes vertically and a single bottom-anchored Aggregator can read
 * whichever pane currently owns the global selection.
 */
export default function TracePane({
  paneId,
  trace,
  parsing,
  parseError,
  selectionStore,
  bindingsStore,
  hoveredPaneStore,
  activePersonaId,
  consumeUrlParams,
  onCancelParse,
  onDismissError,
  onClose,
  compactOverview = false,
}: TracePaneProps) {
  // Pane-scoped view onto the global selection store. Auto-tags every
  // setter call with `paneId` (so the global store can enforce
  // single-pane ownership) and filters reads so deeper components see
  // an empty state when another pane holds the selection. Created once
  // per pane id — re-creating on every render would re-subscribe
  // every canvas/overlay below.
  const paneSelectionView = useMemo(
    () => createPaneSelectionView(selectionStore, paneId),
    [selectionStore, paneId],
  )

  // Auto-detect this pane's "best" persona on every trace load. Each
  // pane owns its own `detectedPersona` (used to label the (auto) tag
  // in the picker) but the *active* persona is global so a single
  // pick affects all panes simultaneously — comparison view's whole
  // point is comparing the same lens across traces.
  const detectedPersona = useMemo(
    () => (trace ? detectPersona(trace) : null),
    [trace],
  )
  const effectivePersonaId = activePersonaId ?? detectedPersona?.id ?? null
  const appliedPersona = useMemo(() => {
    if (!trace || !effectivePersonaId) return null
    const persona = findPersona(effectivePersonaId) ?? detectedPersona
    if (!persona) return null
    return applyPersona(trace, persona)
  }, [trace, effectivePersonaId, detectedPersona])

  // Parse URL deep-link params on the first pane only — the second
  // dropped trace shouldn't snap its viewport to whatever URL the
  // page was originally loaded with. Memoized on `trace` identity so
  // a re-load (back-button, replace-all drop) re-applies them, which
  // matches the legacy single-pane behavior.
  const initial = useMemo<{
    view: InitialView | null
    initialSelectedSlice: ReturnType<typeof resolveInitialSelection>
  }>(() => {
    if (!consumeUrlParams) return {view: null, initialSelectedSlice: null}
    if (!trace) return {view: null, initialSelectedSlice: null}
    if (typeof window === 'undefined') {
      return {view: null, initialSelectedSlice: null}
    }
    const parsed = parseTimelineUrlParams(window.location.search)
    const initialSelectedSlice = parsed.selection
      ? resolveInitialSelection(trace.timeline, parsed.selection)
      : null
    return {view: parsed.view, initialSelectedSlice}
  }, [consumeUrlParams, trace])

  // Stream the in-memory ParsedTrace back out as a gzipped Chrome
  // trace JSON. Same flow as the old TraceViewer — kept here because
  // it's pane-scoped (each trace gets its own download button).
  const handleDownload = useCallback(async () => {
    if (!trace) return
    const stream = zipCompactedTrace(trace)
    await triggerDownload(stream, suggestExportFilename(trace.source))
  }, [trace])

  if (parsing) {
    return (
      <ParseProgressView
        name={parsing.name}
        bytesTotal={parsing.bytesTotal}
        progress={parsing.progress}
        startedAt={parsing.startedAt}
        onCancel={onCancelParse}
      />
    )
  }

  if (parseError) {
    return <ParseErrorView error={parseError} onDismiss={onDismissError} />
  }

  if (!trace || !appliedPersona || !detectedPersona) {
    // Briefly possible during the gap between mount and the first
    // parsing-state being applied. Render an empty pane background so
    // we never paint a half-broken Timeline against a missing trace.
    return <div className="min-h-0 flex-1 bg-[#0b0f17]" />
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="trace-pane"
      data-pane-id={paneId}
    >
      <TracePaneHeader
        source={trace.source}
        compaction={trace.metadata.compaction}
        onClose={onClose}
        onDownload={handleDownload}
      />
      <Timeline
        timeline={trace.timeline}
        selectionStore={paneSelectionView}
        appliedPersona={appliedPersona}
        bindingsStore={bindingsStore}
        initialView={initial.view}
        initialSelectedSlice={initial.initialSelectedSlice}
        paneId={paneId}
        hoveredPaneStore={hoveredPaneStore}
        overviewHeightPx={
          compactOverview
            ? TIMELINE_OVERVIEW_HEIGHT_COMPACT_PX
            : TIMELINE_OVERVIEW_HEIGHT_PX
        }
      />
    </div>
  )
}
