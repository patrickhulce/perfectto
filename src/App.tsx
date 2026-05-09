import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react'
import Aggregator, {type AggregatorPaneInfo} from './components/Aggregator'
import AppHeader, {type AppHeaderTraceMeta} from './components/AppHeader'
import Splash from './components/Splash'
import TracePane, {type ParsingState} from './components/TracePane'
import {type ParseErrorState} from './components/ParseErrorView'
import {
  BUILTIN_PERSONAS,
  detectPersona,
  type ParseProgress,
  type ParsedTrace,
  type Measure,
  type Timeline,
} from './core'
import {SearchMatcher} from './core/matcher'
import {
  suggestExportFilename,
  zipCompactedTrace,
} from './core/export/zipCompactedTrace'
import {triggerDownload} from './components/downloadTrace'
import {loadFile} from './core/utils/loadFile'
import {parseTraceInWorker} from './orchestration'
import {
  createSelectionStore,
  type SliceRef,
} from './components/timeline/selectionStore'
import {createHoveredPaneStore} from './components/timeline/hoveredPaneStore'
import {createLinkedViewportStore} from './components/timeline/linkedViewportStore'
import type {ComparisonMatcher} from './components/timeline/comparisonMatcher'
import {
  createInputBindingsStore,
  type InputBindingsStore,
} from './components/timeline/inputBindingsStore'

/**
 * One trace's worth of state inside the App-level panes array. Each
 * pane independently tracks its own load lifecycle (parsing → loaded
 * or parsing → errored) so an in-flight parse on pane B never blanks
 * out a fully-loaded pane A. The `id` is stable across replace /
 * reorder so React keys + the `selectionStore.paneId` ownership
 * mechanism stay aligned.
 */
interface Pane {
  id: string
  trace: ParsedTrace | null
  parsing: ParsingState | null
  parseError: ParseErrorState | null
}

const DEFAULT_AUTOLOAD_NAME = 'perfecto-chrome-trace'

// Soft cap on decompressed bytes pulled into the worker before we
// truncate. 4 GiB is well above what any reasonable Chrome / DevTools
// trace produces (a 60-second renderer trace at peak detail is ~1.5
// GiB uncompressed) and well below the point where a single browser
// tab will OOM on the structured-clone payload.
const PARSE_MAX_BYTES = 4 * 1024 * 1024 * 1024

/**
 * Drop-zone hit-test geometry for the multi-pane comparison view.
 * The center rectangle wraps "replace all", with the rest of the top
 * half = prepend and the rest of the bottom half = append. Sized at
 * 40% × 30% so the center reads as a clearly-bounded inset target
 * without being so small that the user has to aim for it precisely.
 *
 * Constants live here so {@link hitTestDropZone} and the visual
 * overlay below paint the exact same geometry — any future tuning
 * happens in one place.
 */
const CENTER_WIDTH_FRACTION = 0.4
const CENTER_HEIGHT_FRACTION = 0.3

/**
 * Drop intent resolved from cursor position.
 *
 *  - `'first'`: the first ever pane on this app session. Used by the
 *    splash callback and by drag-overs while `panes.length === 0`.
 *  - `'top'` / `'bottom'`: the user dropped in the upper or lower
 *    half. The action `runParse` actually takes depends on
 *    `panes.length` — see the switch below for the routing rules.
 *  - `'center'`: the inset rectangle. Always wipes every pane and
 *    replaces them with the new file.
 */
type DropTarget = 'first' | 'top' | 'bottom' | 'center'

/**
 * App-wide input-bindings store. Created lazily once and kept at
 * module scope because a user's preferred matrix shouldn't reset
 * when they load a new trace.
 */
let sharedInputBindingsStore: InputBindingsStore | null = null
function getBindingsStore(): InputBindingsStore {
  if (sharedInputBindingsStore === null) {
    sharedInputBindingsStore = createInputBindingsStore()
  }
  return sharedInputBindingsStore
}

let nextPaneIdCounter = 0
function makePaneId(): string {
  // Monotonically increasing string keeps React keys + selection
  // store ownership stable. Reset would only happen on a full page
  // reload, which is fine.
  nextPaneIdCounter += 1
  return `pane-${nextPaneIdCounter}`
}

function createMeasureResolver(timeline: Timeline): (slice: SliceRef) => Measure | null {
  const byId = new Map<string, Measure>()
  const byTrack = new Map<string, Measure[]>()
  for (const system of timeline.systems) {
    for (const track of system.tracks) {
      const measures: Measure[] = []
      byTrack.set(track.id, measures)
      const walk = (items: readonly Measure[]): void => {
        for (const measure of items) {
          byId.set(measure.id, measure)
          measures.push(measure)
          walk(measure.measures)
        }
      }
      walk(track.measures)
    }
  }
  return slice => {
    if (slice.measureId) {
      const exact = byId.get(slice.measureId)
      if (exact) return exact
    }
    const measures = byTrack.get(slice.trackId) ?? []
    return (
      measures.find(
        m =>
          Math.abs(m.start - slice.startMs) < 1e-4 &&
          Math.abs(m.end - slice.endMs) < 1e-4,
      ) ?? null
    )
  }
}

/**
 * Resolve a drop position to its target zone. Center rectangle wins
 * (so a drop dead-center is `'center'` even though it's also
 * technically in the top half by the y-only test); outside the
 * center rectangle the y midline splits top vs bottom.
 */
function hitTestDropZone(
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight: number,
): 'top' | 'bottom' | 'center' {
  const cw = viewportWidth * CENTER_WIDTH_FRACTION
  const ch = viewportHeight * CENTER_HEIGHT_FRACTION
  const cx0 = (viewportWidth - cw) / 2
  const cx1 = cx0 + cw
  const cy0 = (viewportHeight - ch) / 2
  const cy1 = cy0 + ch
  const inCenter =
    clientX >= cx0 && clientX <= cx1 && clientY >= cy0 && clientY <= cy1
  if (inCenter) return 'center'
  return clientY < viewportHeight / 2 ? 'top' : 'bottom'
}

export default function App() {
  const [panes, setPanes] = useState<Pane[]>([])
  // Mirror to refs so async callbacks (parse handlers) read the
  // latest value without re-subscribing every render.
  const panesRef = useRef(panes)
  panesRef.current = panes

  /**
   * Globally-active persona id. Seeded from the first pane to ever
   * finish loading (auto-detect against that trace). Subsequent
   * loads don't re-seed — once the user has a picked persona they
   * own it; comparing two traces under different personas wouldn't
   * make sense anyway, the whole point is one shared lens.
   */
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null)

  // Global stores. Created once per App mount. Each TracePane wraps
  // `selectionStore` in a per-pane view internally.
  const selectionStore = useMemo(() => createSelectionStore(), [])
  const hoveredPaneStore = useMemo(() => createHoveredPaneStore(), [])
  const linkedViewportStore = useMemo(() => createLinkedViewportStore(), [])
  const bindingsStore = getBindingsStore()

  // Drop-zone UI state. `dropTarget` is the zone the cursor is
  // currently over while a drag is active; rendered as a highlighted
  // region in the overlay so the user can see where their drop will
  // land before they release.
  const [isDragging, setIsDragging] = useState(false)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)

  /**
   * Run a parse against a target action. Allocates a new pane id,
   * inserts it into `panes` per the target, then walks through
   * load → parse → trace transition for that pane only. Other panes
   * keep their state untouched (one in-flight parse never blanks
   * another pane's loaded trace).
   */
  const runParse = async (file: File, target: DropTarget): Promise<void> => {
    const prevPanes = panesRef.current
    // Abort any in-flight parse on the panes that are about to be
    // displaced. Replace-all (`'center'` and the `'first'` initial
    // load) clears every pane; `'top'`/`'bottom'` only clear their
    // slot when we're already at the N=2 cap and replacing in
    // place. Without this the abandoned controllers would race the
    // new parse and could write stale state into panes that no
    // longer exist.
    const abortIds = new Set<string>()
    if (target === 'center' || target === 'first') {
      for (const p of prevPanes) abortIds.add(p.id)
    } else if (target === 'top' && prevPanes.length === 2) {
      abortIds.add(prevPanes[0].id)
    } else if (target === 'bottom' && prevPanes.length === 2) {
      abortIds.add(prevPanes[1].id)
    }
    for (const p of prevPanes) {
      if (abortIds.has(p.id)) p.parsing?.controller.abort()
    }

    const newPaneId = makePaneId()
    const newPane: Pane = {
      id: newPaneId,
      trace: null,
      parsing: null,
      parseError: null,
    }
    setPanes(prev => {
      switch (target) {
        case 'first':
          return [newPane]
        case 'center':
          return [newPane]
        case 'top':
          // 0 panes → seed; 1 pane → prepend (becomes [new, old]);
          // 2 panes → replace pane[0] in place, keep pane[1].
          if (prev.length === 0) return [newPane]
          if (prev.length === 1) return [newPane, ...prev]
          return [newPane, prev[1]]
        case 'bottom':
          // 0 panes → seed; 1 pane → append (becomes [old, new]);
          // 2 panes → replace pane[1] in place, keep pane[0].
          if (prev.length === 0) return [newPane]
          if (prev.length === 1) return [...prev, newPane]
          return [prev[0], newPane]
      }
    })

    let loaded
    try {
      loaded = await loadFile(file)
    } catch (err) {
      const asErr = err instanceof Error ? err : new Error(String(err))
      setPanes(prev =>
        prev.map(p =>
          p.id === newPaneId
            ? {
                ...p,
                parsing: null,
                parseError: {
                  name: file.name,
                  message: asErr.message || 'Trace load failed',
                  detail:
                    asErr.name && asErr.name !== 'Error' ? asErr.name : undefined,
                },
              }
            : p,
        ),
      )
      return
    }

    const controller = new AbortController()
    const initialProgress: ParseProgress = {
      streamIndex: 0,
      bytesRead: 0,
      phase: 'parsing',
    }
    const parsing: ParsingState = {
      name: loaded.name,
      bytesTotal: loaded.uncompressedSize ?? loaded.size,
      progress: initialProgress,
      startedAt: Date.now(),
      controller,
    }
    setPanes(prev =>
      prev.map(p => (p.id === newPaneId ? {...p, parsing} : p)),
    )

    try {
      const parsed = await parseTraceInWorker(
        loaded.stream,
        {name: loaded.name, size: loaded.size},
        {
          signal: controller.signal,
          maxBytes: PARSE_MAX_BYTES,
          onProgress: progress => {
            setPanes(prev =>
              prev.map(p =>
                p.id === newPaneId && p.parsing
                  ? {...p, parsing: {...p.parsing, progress}}
                  : p,
              ),
            )
          },
        },
      )
      setPanes(prev =>
        prev.map(p =>
          p.id === newPaneId
            ? {...p, trace: parsed, parsing: null, parseError: null}
            : p,
        ),
      )
      // Persona seeding: only fire on the very first successfully
      // loaded trace anywhere. Subsequent panes inherit whatever
      // persona the user is on.
      setActivePersonaId(prev =>
        prev !== null ? prev : detectPersona(parsed).id,
      )
    } catch (err) {
      // User-initiated abort: drop the pane silently and let panes
      // collapse back to splash if it was the only one. Matches the
      // legacy single-trace "cancel mid-parse → splash" UX.
      if ((err as {name?: string} | null)?.name === 'AbortError') {
        setPanes(prev => prev.filter(p => p.id !== newPaneId))
        return
      }
      const asErr = err instanceof Error ? err : new Error(String(err))
      setPanes(prev =>
        prev.map(p =>
          p.id === newPaneId
            ? {
                ...p,
                parsing: null,
                parseError: {
                  name: loaded.name,
                  message: asErr.message || 'Trace parsing failed',
                  detail:
                    asErr.name && asErr.name !== 'Error' ? asErr.name : undefined,
                },
              }
            : p,
        ),
      )
    }
  }

  // Splash → first pane. Identical effect to a top/bottom drop with
  // no panes, but exposed as a callback for the file-input click
  // path that can't synthesize a drag event.
  const handleSplashFile = (file: File): void => {
    void runParse(file, 'first')
  }

  // Dev-only autoload (unchanged from the legacy flow). Skipped in
  // production via `process.env.NODE_ENV` and in jest via NODE_ENV.
  const autoloadStarted = useRef(false)
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return
    if (autoloadStarted.current) return
    if (typeof window === 'undefined') return
    autoloadStarted.current = true

    const param = new URLSearchParams(window.location.search).get('autoload')
    if (param === 'off') return

    const rawName = param ?? DEFAULT_AUTOLOAD_NAME
    const baseName = rawName.endsWith('.json') ? rawName.slice(0, -5) : rawName
    const fileName = `${baseName}.json`

    void (async () => {
      try {
        const response = await fetch(`/assets/${fileName}`)
        if (!response.ok) {
          console.warn(`[autoload] /assets/${fileName} → ${response.status}`)
          return
        }
        const blob = await response.blob()
        const file = new File([blob], fileName, {type: 'application/json'})
        await runParse(file, 'first')
      } catch (err) {
        console.warn('[autoload] failed', err)
      }
    })()
    // Effect runs once on mount; runParse is not in deps because we
    // intentionally only fire the autoload when there's nothing
    // else loaded yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Page-wide drop target. Pulls cursor coords off the event so the
  // hit-test mirrors what the overlay highlight is showing.
  const handleDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    if (!isDragging) setIsDragging(true)
    if (panesRef.current.length === 0) {
      setDropTarget('first')
      return
    }
    const target = hitTestDropZone(
      e.clientX,
      e.clientY,
      window.innerWidth,
      window.innerHeight,
    )
    setDropTarget(target)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setIsDragging(false)
    setDropTarget(null)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setIsDragging(false)
    setDropTarget(null)
    const file = e.dataTransfer.files[0]
    if (!file) return
    let target: DropTarget
    if (panesRef.current.length === 0) {
      target = 'first'
    } else {
      target = hitTestDropZone(
        e.clientX,
        e.clientY,
        window.innerWidth,
        window.innerHeight,
      )
    }
    void runParse(file, target)
  }

  const handleClosePane = (paneId: string): void => {
    const pane = panesRef.current.find(p => p.id === paneId)
    pane?.parsing?.controller.abort()
    setPanes(prev => prev.filter(p => p.id !== paneId))
  }

  const handleCancelParse = (paneId: string): void => {
    const pane = panesRef.current.find(p => p.id === paneId)
    pane?.parsing?.controller.abort()
    // The runParse error handler removes the pane on AbortError, so
    // we don't need to also set state here.
  }

  const handleDismissError = (paneId: string): void => {
    setPanes(prev => prev.filter(p => p.id !== paneId))
  }

  // Pane lookup for the global Aggregator. Only panes with a loaded
  // trace are eligible — one mid-parse can't be the active selection
  // owner because there's no Timeline mounted yet to write into the
  // store.
  const aggregatorPanes = useMemo<AggregatorPaneInfo[]>(() => {
    const out: AggregatorPaneInfo[] = []
    for (const p of panes) {
      if (p.trace) {
        out.push({id: p.id, name: p.trace.source.name, timeline: p.trace.timeline})
      }
    }
    return out
  }, [panes])

  const comparisonMatchers = useMemo<Map<string, ComparisonMatcher>>(() => {
    const out = new Map<string, ComparisonMatcher>()
    if (panes.length !== 2) return out
    const [a, b] = panes
    if (!a.trace || !b.trace) return out
    const resolveA = createMeasureResolver(a.trace.timeline)
    const resolveB = createMeasureResolver(b.trace.timeline)
    out.set(a.id, {
      matcher: new SearchMatcher(b.trace, a.trace),
      resolveForeignMeasure: resolveB,
    })
    out.set(b.id, {
      matcher: new SearchMatcher(a.trace, b.trace),
      resolveForeignMeasure: resolveA,
    })
    return out
  }, [panes])

  // Detected-persona id for the global picker's `(auto)` tag. We
  // intentionally pull from the *first loaded* pane only — the
  // picker affordance is a single label, and rotating it on every
  // additional drop would be more confusing than helpful when the
  // user is comparing two traces with possibly-different best-fit
  // personas. Matches the existing "first load seeds activePersonaId"
  // contract.
  const detectedPersonaId = useMemo<string | undefined>(() => {
    const firstLoaded = aggregatorPanes[0]
    if (!firstLoaded) return undefined
    const pane = panes.find(p => p.id === firstLoaded.id)
    return pane?.trace ? detectPersona(pane.trace).id : undefined
  }, [aggregatorPanes, panes])

  // Per-trace metadata exposed in the global header at N=1. At N≥2 we
  // hide this and let each pane's TracePaneHeader carry its own
  // size/compaction/download — there's no single "the trace" to
  // download in compare mode. The download stream itself is wired
  // here (instead of inside TracePane) so the AppHeader can host the
  // button without TracePane needing a callback channel back up.
  const singlePaneMeta = useMemo<AppHeaderTraceMeta | undefined>(() => {
    if (panes.length !== 1) return undefined
    const trace = panes[0].trace
    if (!trace) return undefined
    return {
      source: trace.source,
      compaction: trace.metadata.compaction,
      onDownload: async () => {
        const stream = zipCompactedTrace(trace)
        await triggerDownload(stream, suggestExportFilename(trace.source))
      },
    }
  }, [panes])

  // Closing all panes returns to the splash. Wired into AppHeader's
  // back button.
  const handleBackToSplash = (): void => {
    for (const p of panesRef.current) {
      p.parsing?.controller.abort()
    }
    setPanes([])
  }

  let body: ReactNode
  if (panes.length === 0) {
    body = <Splash onFileSelected={handleSplashFile} />
  } else {
    body = (
      <>
        <AppHeader
          panes={aggregatorPanes}
          onBack={handleBackToSplash}
          singlePaneMeta={singlePaneMeta}
          personas={BUILTIN_PERSONAS}
          activePersonaId={activePersonaId ?? detectedPersonaId}
          detectedPersonaId={detectedPersonaId}
          onPersonaChange={setActivePersonaId}
          bindingsStore={bindingsStore}
        />
        {panes.map((pane, idx) => (
          <TracePane
            key={pane.id}
            paneId={pane.id}
            trace={pane.trace}
            parsing={pane.parsing}
            parseError={pane.parseError}
            selectionStore={selectionStore}
            bindingsStore={bindingsStore}
            hoveredPaneStore={hoveredPaneStore}
            linkedViewportStore={panes.length >= 2 ? linkedViewportStore : null}
            comparisonMatcher={comparisonMatchers.get(pane.id) ?? null}
            activePersonaId={activePersonaId}
            consumeUrlParams={idx === 0}
            onCancelParse={() => handleCancelParse(pane.id)}
            onDismissError={() => handleDismissError(pane.id)}
            onClose={() => handleClosePane(pane.id)}
            compactOverview={panes.length >= 2}
            hideHeader={panes.length === 1}
          />
        ))}
        <Aggregator
          selectionStore={selectionStore}
          panes={aggregatorPanes}
        />
      </>
    )
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative flex h-screen min-h-0 flex-col"
    >
      {body}
      {isDragging && (
        <DropOverlay target={dropTarget} paneCount={panes.length} />
      )}
    </div>
  )
}

interface DropOverlayProps {
  target: DropTarget | null
  paneCount: number
}

/**
 * Translucent visual that shows the user where their drop will land.
 *
 *  - With no panes loaded: a single full-page dashed box (matches the
 *    legacy splash drop affordance).
 *  - With one pane loaded: top = "Add to top", bottom = "Add to
 *    bottom", center = "Replace all".
 *  - With two panes loaded (the cap): top = "Replace top", bottom =
 *    "Replace bottom" (slot replacement instead of stacking past
 *    N=2), center = "Replace all".
 *
 * Geometry comes from {@link CENTER_WIDTH_FRACTION} /
 * {@link CENTER_HEIGHT_FRACTION} so what's painted matches what
 * `hitTestDropZone` resolves on drop.
 */
function DropOverlay({target, paneCount}: DropOverlayProps) {
  if (paneCount === 0) {
    return (
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,17,23,0.6)] backdrop-blur-sm"
      >
        <div className="m-6 flex h-[calc(100%-3rem)] w-[calc(100%-3rem)] items-center justify-center rounded-2xl border-[3px] border-dashed border-[#667eea] bg-[rgba(102,126,234,0.07)]">
          <p className="text-2xl font-semibold text-[#e2e8f0]">Drop to load trace</p>
        </div>
      </div>
    )
  }
  const centerW = `${CENTER_WIDTH_FRACTION * 100}%`
  const centerH = `${CENTER_HEIGHT_FRACTION * 100}%`
  // At N=2 the slot already exists so a top/bottom drop replaces in
  // place; at N=1 it adds a new slot above/below the current one.
  const topLabel = paneCount >= 2 ? 'Replace top' : 'Add to top'
  const bottomLabel = paneCount >= 2 ? 'Replace bottom' : 'Add to bottom'
  return (
    <div
      aria-hidden
      data-testid="drop-overlay"
      className="pointer-events-none fixed inset-0 z-50 bg-[rgba(15,17,23,0.4)] backdrop-blur-[2px]"
    >
      <div
        data-testid="drop-zone-top"
        data-active={target === 'top' ? 'true' : undefined}
        className={
          'absolute left-0 right-0 top-0 flex h-1/2 items-center justify-center border-2 border-dashed transition-colors ' +
          (target === 'top'
            ? 'border-[#667eea] bg-[rgba(102,126,234,0.18)]'
            : 'border-[#2d3748] bg-transparent')
        }
      >
        <p
          className={
            'text-lg font-semibold ' +
            (target === 'top' ? 'text-[#e2e8f0]' : 'text-[#4a5568]')
          }
        >
          {topLabel}
        </p>
      </div>
      <div
        data-testid="drop-zone-bottom"
        data-active={target === 'bottom' ? 'true' : undefined}
        className={
          'absolute bottom-0 left-0 right-0 flex h-1/2 items-center justify-center border-2 border-dashed transition-colors ' +
          (target === 'bottom'
            ? 'border-[#667eea] bg-[rgba(102,126,234,0.18)]'
            : 'border-[#2d3748] bg-transparent')
        }
      >
        <p
          className={
            'text-lg font-semibold ' +
            (target === 'bottom' ? 'text-[#e2e8f0]' : 'text-[#4a5568]')
          }
        >
          {bottomLabel}
        </p>
      </div>
      {/* Concentric center rectangle for "replace all". Sits above
          the two half-strips so its highlighted edges read clearly.
          The center rectangle's pointer events stay disabled (parent
          set), but its highlight wins visually when hit. */}
      <div
        data-testid="drop-zone-center"
        data-active={target === 'center' ? 'true' : undefined}
        className={
          'absolute flex items-center justify-center rounded-2xl border-[3px] border-dashed transition-colors ' +
          (target === 'center'
            ? 'border-[#667eea] bg-[rgba(102,126,234,0.28)]'
            : 'border-[#4a5568] bg-[rgba(15,17,23,0.5)]')
        }
        style={{
          width: centerW,
          height: centerH,
          left: `calc(50% - (${centerW} / 2))`,
          top: `calc(50% - (${centerH} / 2))`,
        }}
      >
        <p
          className={
            'text-lg font-semibold ' +
            (target === 'center' ? 'text-[#e2e8f0]' : 'text-[#a0aec0]')
          }
        >
          Replace all
        </p>
      </div>
    </div>
  )
}

