import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import ParseProgressView from './components/ParseProgressView'
import Splash from './components/Splash'
import TraceViewer from './components/TraceViewer'
import { type ParseProgress, type ParsedTrace } from './core'
import { loadFile } from './core/utils/loadFile'
import { parseTraceInWorker } from './orchestration'

interface ParsingState {
  name: string
  /**
   * Denominator for the progress bar. For gzipped inputs this is the
   * uncompressed payload size (read from the ISIZE trailer at load
   * time); for plain files it's the file size. Lined up with the
   * worker's decompressed-bytes counter.
   */
  bytesTotal: number
  progress: ParseProgress
  startedAt: number
  controller: AbortController
}

interface ParseErrorState {
  name: string
  message: string
  detail?: string
}

const DEFAULT_AUTOLOAD_NAME = 'perfecto-chrome-trace'

// Soft cap on decompressed bytes pulled into the worker before we
// truncate. 4 GiB is well above what any reasonable Chrome / DevTools
// trace produces (a 60-second renderer trace at peak detail is ~1.5
// GiB uncompressed) and well below the point where a single browser
// tab will OOM on the structured-clone payload. Drag-dropping a
// runaway file (a 50 GiB Linux ftrace by mistake) hits this cap and
// the user gets a partial flame chart instead of a hung tab.
const PARSE_MAX_BYTES = 4 * 1024 * 1024 * 1024

export default function App() {
  const [trace, setTrace] = useState<ParsedTrace | null>(null)
  // Bumped on every successful trace load. Used as the React key for
  // `TraceViewer` so a drag-drop replacement re-mounts the entire
  // viewer subtree — which is the only way to consistently reset
  // persona auto-detection, selection state, and the timeline
  // viewport. Without this, `useState(detectedPersona.id)` inside
  // `TraceViewer` would carry the previous trace's persona forward.
  const [traceLoadId, setTraceLoadId] = useState(0)
  const [parsing, setParsing] = useState<ParsingState | null>(null)
  const [parseError, setParseError] = useState<ParseErrorState | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  // Latest parsing controller, accessible from the drop handler without
  // re-creating it on every state change. Lets a drop mid-parse abort
  // the in-flight worker before kicking off the replacement parse.
  const parsingRef = useRef<ParsingState | null>(null)
  parsingRef.current = parsing

  const runParse = async (file: File): Promise<void> => {
    setParseError(null)
    const loaded = await loadFile(file)
    const controller = new AbortController()
    const initial: ParseProgress = {
      streamIndex: 0,
      bytesRead: 0,
      phase: 'parsing',
    }
    setParsing({
      name: loaded.name,
      bytesTotal: loaded.uncompressedSize ?? loaded.size,
      progress: initial,
      startedAt: Date.now(),
      controller,
    })

    try {
      const parsed = await parseTraceInWorker(
        loaded.stream,
        { name: loaded.name, size: loaded.size },
        {
          signal: controller.signal,
          maxBytes: PARSE_MAX_BYTES,
          onProgress: (p) =>
            setParsing((prev) => (prev ? { ...prev, progress: p } : prev)),
        },
      )
      setTrace(parsed)
      setTraceLoadId((n) => n + 1)
    } catch (err) {
      // Silence user-initiated aborts; surface every other failure mode
      // as a visible error state instead of re-throwing into React (which
      // leaves the splash mounted but invisible under the default error
      // boundary).
      if ((err as { name?: string } | null)?.name === 'AbortError') return
      const asErr = err instanceof Error ? err : new Error(String(err))
      setParseError({
        name: loaded.name,
        message: asErr.message || 'Trace parsing failed',
        detail: asErr.name && asErr.name !== 'Error' ? asErr.name : undefined,
      })
    } finally {
      setParsing(null)
    }
  }

  const handleFileSelected = async (file: File) => {
    await runParse(file)
  }

  // Dev-only autoload: fetch a checked-in asset on mount so iterating
  // on the viewer doesn't require re-picking the sample trace each
  // reload. Gated on `process.env.NODE_ENV === 'development'` — Vite
  // statically replaces this at build time so production bundles get a
  // `false` branch that tree-shakes out; Jest keeps its own
  // `NODE_ENV === 'test'` so tests also skip autoload. Override via
  // `?autoload=<name>` (reads `/assets/<name>.json`) or disable with
  // `?autoload=off`.
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
        const file = new File([blob], fileName, { type: 'application/json' })
        await handleFileSelected(file)
      } catch (err) {
        console.warn('[autoload] failed', err)
      }
    })()
  }, [])

  // Page-wide drop target: the user can drop a trace anywhere to
  // replace whatever's currently on screen (splash, in-flight parse,
  // loaded viewer, or error view). Splash keeps its own dashed-box
  // affordance for click-to-browse but no longer owns drop handling
  // — that's now a single source of truth here.
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    if (!isDragging) setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setIsDragging(false)
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (!file) return
    const inflight = parsingRef.current
    if (inflight) inflight.controller.abort()
    void runParse(file)
  }

  // Priority: an in-flight parse always wins, even if a previous
  // trace is still in `trace`, so a drop-on-existing-trace transitions
  // through the same Splash → Progress → Viewer flow as the initial
  // load. Errors come next so a failed replacement surfaces instead
  // of silently keeping the stale viewer up. Falling back to `trace`
  // when none of those are set means dismissing an error after a
  // failed replacement returns to the previously loaded trace.
  let body: ReactNode
  if (parsing) {
    body = (
      <ParseProgressView
        name={parsing.name}
        bytesTotal={parsing.bytesTotal}
        progress={parsing.progress}
        startedAt={parsing.startedAt}
        onCancel={() => parsing.controller.abort()}
      />
    )
  } else if (parseError) {
    body = (
      <ParseErrorView
        error={parseError}
        onDismiss={() => setParseError(null)}
      />
    )
  } else if (trace) {
    body = (
      <TraceViewer
        key={traceLoadId}
        trace={trace}
        onBack={() => setTrace(null)}
      />
    )
  } else {
    body = <Splash onFileSelected={handleFileSelected} />
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative flex min-h-screen flex-col"
    >
      {body}
      {isDragging && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,17,23,0.6)] backdrop-blur-sm"
        >
          <div className="m-6 flex h-[calc(100%-3rem)] w-[calc(100%-3rem)] items-center justify-center rounded-2xl border-[3px] border-dashed border-[#667eea] bg-[rgba(102,126,234,0.07)]">
            <p className="text-2xl font-semibold text-[#e2e8f0]">
              Drop to {trace ? 'replace trace' : 'load trace'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Rendered when `parseTraceInWorker` rejects with anything other than
 * an `AbortError`. Surfaces the worker's error message + a retry/back
 * path so an OOM, unexpected trace format, or parse bug doesn't leave
 * the user on an unrecoverable blank page.
 */
function ParseErrorView({
  error,
  onDismiss,
}: {
  error: ParseErrorState
  onDismiss: () => void
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="flex w-full max-w-[640px] flex-col gap-5 rounded-2xl border border-[#fc8181]/60 bg-[rgba(252,129,129,0.06)] p-8">
        <h1 className="text-2xl font-semibold text-[#fc8181]">
          Couldn&apos;t parse that trace
        </h1>
        <div>
          <p className="truncate text-sm text-[#a0aec0]" title={error.name}>
            {error.name}
          </p>
          <p className="mt-2 text-sm text-[#e2e8f0]">{error.message}</p>
          {error.detail && (
            <p className="mt-2 text-xs uppercase tracking-wider text-[#718096]">
              {error.detail}
            </p>
          )}
        </div>
        <ul className="list-disc space-y-1 pl-5 text-xs text-[#a0aec0]">
          <li>
            If the file is over ~2 GB, try the Chrome DevTools sample-rate knob or
            pre-split the trace before loading.
          </li>
          <li>
            Gzipped traces (`.gz`, or any file whose first two bytes are
            `1f 8b`) are decompressed automatically; other archive
            wrappers (`.zip`, `.tar.gz`) need to be unpacked first.
          </li>
          <li>
            Browser worker OOMs surface here; closing other tabs can free the
            headroom we need.
          </li>
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="cursor-pointer rounded-lg border border-[#4a5568] bg-transparent px-4 py-1.5 text-sm text-[#a0aec0] transition-colors hover:border-[#667eea] hover:text-[#667eea]"
          >
            Try another file
          </button>
        </div>
      </div>
    </div>
  )
}
