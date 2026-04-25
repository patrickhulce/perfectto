import {useState} from 'react'
import {formatBytes} from '../core/utils/formatBytes'
import type {CompactionMetadata, Persona, TraceSource} from '../core'
import PersonaPicker from './PersonaPicker'
import SettingsPanel, {SettingsCog} from './SettingsPanel'
import type {InputBindingsStore} from './timeline/inputBindingsStore'

interface MetadataProps {
  source: TraceSource
  onBack: () => void
  personas?: readonly Persona[]
  activePersonaId?: string
  detectedPersonaId?: string
  onPersonaChange?: (id: string) => void
  /**
   * Input-binding store. When provided, the settings cog is shown in
   * the top-right of the header and opens a flipout panel. Optional
   * because some minimal test harnesses mount `Metadata` without a
   * viewer tree.
   */
  bindingsStore?: InputBindingsStore
  /**
   * Optional compaction counters produced by the parser. When non-zero
   * totals are present we render a small pill so users can see that
   * large-trace auto-compaction fired on the current file.
   */
  compaction?: CompactionMetadata
}

export default function Metadata({
  source,
  onBack,
  personas,
  activePersonaId,
  detectedPersonaId,
  onPersonaChange,
  bindingsStore,
  compaction,
}: MetadataProps) {
  const totalFolded =
    (compaction?.onlineEventsFolded ?? 0) +
    (compaction?.siblingEventsFolded ?? 0) +
    (compaction?.cpuTinyEventsFolded ?? 0) +
    (compaction?.subpixelEventsFolded ?? 0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <>
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
        {compaction && totalFolded > 0 && (
          <span
            className="whitespace-nowrap rounded border border-[#f6ad55]/40 bg-[#f6ad55]/10 px-2 py-0.5 font-mono text-[10px] text-[#f6ad55]"
            title={
              `Large-trace compaction: ${compaction.siblingEventsFolded.toLocaleString()} sibling · ` +
              `${compaction.cpuTinyEventsFolded.toLocaleString()} cpu-tiny · ` +
              `${compaction.subpixelEventsFolded.toLocaleString()} subpixel-subtree` +
              (compaction.subpixelMaxDepthFolded > 0
                ? ` (≤ ${compaction.subpixelMaxDepthFolded} deep)`
                : '') +
              ` · ${compaction.onlineEventsFolded.toLocaleString()} online` +
              (compaction.onlineTriggered ? ' (streaming cap hit)' : '')
            }
            data-testid="metadata-compaction-pill"
          >
            {totalFolded.toLocaleString()} folded
          </span>
        )}
        {bindingsStore && (
          <SettingsCog onClick={() => setSettingsOpen(v => !v)} />
        )}
      </div>
      {bindingsStore && (
        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          bindingsStore={bindingsStore}
        />
      )}
    </>
  )
}
