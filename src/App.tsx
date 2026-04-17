import { useState } from 'react'
import ParseProgressView from './components/ParseProgressView'
import Splash from './components/Splash'
import TraceViewer from './components/TraceViewer'
import { parseTrace, type ParseProgress, type ParsedTrace } from './core'
import { loadFile } from './utils/loadFile'

interface ParsingState {
  name: string
  bytesTotal: number
  progress: ParseProgress
  controller: AbortController
}

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
      const parsed = await parseTrace(
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
