import { useEffect, useRef, useState } from 'react'
import ParseProgressView from './components/ParseProgressView'
import Splash from './components/Splash'
import TraceViewer from './components/TraceViewer'
import { type ParseProgress, type ParsedTrace } from './core'
import { loadFile } from './core/utils/loadFile'
import { parseTraceInWorker } from './orchestration'

interface ParsingState {
  name: string
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

export default function App() {
  const [trace, setTrace] = useState<ParsedTrace | null>(null)
  const [parsing, setParsing] = useState<ParsingState | null>(null)
  const [parseError, setParseError] = useState<ParseErrorState | null>(null)

  const runParse = async (file: File): Promise<void> => {
    setParseError(null)
    const loaded = loadFile(file)
    const controller = new AbortController()
    const initial: ParseProgress = {
      streamIndex: 0,
      bytesRead: 0,
      phase: 'parsing',
    }
    setParsing({
      name: loaded.name,
      bytesTotal: loaded.size,
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
          onProgress: (p) =>
            setParsing((prev) => (prev ? { ...prev, progress: p } : prev)),
        },
      )
      setTrace(parsed)
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

  if (trace) {
    return <TraceViewer trace={trace} onBack={() => setTrace(null)} />
  }
  if (parsing) {
    return (
      <ParseProgressView
        name={parsing.name}
        bytesTotal={parsing.bytesTotal}
        progress={parsing.progress}
        startedAt={parsing.startedAt}
        onCancel={() => parsing.controller.abort()}
      />
    )
  }
  if (parseError) {
    return (
      <ParseErrorView
        error={parseError}
        onDismiss={() => setParseError(null)}
      />
    )
  }
  return <Splash onFileSelected={handleFileSelected} />
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
            Some traces need to be saved as raw Chrome Trace Event Format — pretty-
            printed JSON or wrapped `.gz` files aren&apos;t supported yet.
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
