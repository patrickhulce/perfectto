import {formatBytes} from '../core/utils/formatBytes'
import type {Persona, TraceSource} from '../core'
import PersonaPicker from './PersonaPicker'

interface MetadataProps {
  source: TraceSource
  onBack: () => void
  personas?: readonly Persona[]
  activePersonaId?: string
  detectedPersonaId?: string
  onPersonaChange?: (id: string) => void
}

export default function Metadata({
  source,
  onBack,
  personas,
  activePersonaId,
  detectedPersonaId,
  onPersonaChange,
}: MetadataProps) {
  return (
    <div className="flex items-center gap-4 border-b border-[#2d3748] bg-[#1a202c] px-6 py-4">
      <button
        type="button"
        onClick={onBack}
        className="cursor-pointer rounded-lg border border-[#4a5568] bg-transparent px-4 py-1.5 text-sm text-[#a0aec0] transition-colors hover:border-[#667eea] hover:text-[#667eea]"
      >
        ← Back
      </button>
      <h2 className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[1.1rem] font-semibold text-[#e2e8f0]">
        {source.name}
      </h2>
      {personas && activePersonaId && detectedPersonaId && onPersonaChange && (
        <PersonaPicker
          personas={personas}
          activeId={activePersonaId}
          detectedId={detectedPersonaId}
          onChange={onPersonaChange}
        />
      )}
      <span className="whitespace-nowrap text-xs text-[#718096]">{formatBytes(source.size)}</span>
    </div>
  )
}
