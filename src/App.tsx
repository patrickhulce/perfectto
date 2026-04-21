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
  controller: AbortController
}

const DEFAULT_AUTOLOAD_NAME = 'perfecto-chrome-trace'

export default function App() {
  const [trace, setTrace] = useState<ParsedTrace | null>(null)
  const [parsing, setParsing] = useState<ParsingState | null>(null)

  const handleFileSelected = async (file: File) => {
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
      if ((err as { name?: string } | null)?.name !== 'AbortError') {
        throw err
      }
    } finally {
      setParsing(null)
    }
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
        onCancel={() => parsing.controller.abort()}
      />
    )
  }
  return <Splash onFileSelected={handleFileSelected} />
}
