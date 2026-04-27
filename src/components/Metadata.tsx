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
  /**
   * Optional callback that exports the current trace as a gzipped
   * Chrome trace JSON. When provided, the header shows a Download
   * button next to the size text. The button is disabled while the
   * promise is in flight so quick double-clicks can't queue up
   * multiple downloads.
   */
  onDownload?: () => Promise<void>
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
  onDownload,
}: MetadataProps) {
  const totalFolded =
    (compaction?.onlineEventsFolded ?? 0) +
    (compaction?.siblingEventsFolded ?? 0) +
    (compaction?.cpuTinyEventsFolded ?? 0) +
    (compaction?.subpixelEventsFolded ?? 0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)

  const handleDownloadClick = async (): Promise<void> => {
    if (!onDownload || downloading) return
    setDownloading(true)
    try {
      await onDownload()
    } catch (err) {
      // Keep the user moving rather than freezing the UI on a
      // download failure. Surface a console error and clear state so
      // they can retry. Real telemetry can hook in later.
      console.error('compacted-trace download failed', err)
    } finally {
      setDownloading(false)
    }
  }

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
        {onDownload && (
          <button
            type="button"
            onClick={handleDownloadClick}
            disabled={downloading}
            aria-label="Download compacted trace"
            title={
              downloading
                ? 'Saving…'
                : 'Download compacted trace (lossy roundtrip — fast to re-load for dev iteration)'
            }
            data-testid="metadata-download-button"
            className="cursor-pointer rounded-lg border border-[#4a5568] bg-transparent p-1.5 text-[#a0aec0] transition-colors hover:border-[#667eea] hover:text-[#667eea] disabled:cursor-wait disabled:opacity-50"
          >
            {downloading ? <SpinnerIcon /> : <DownloadIcon />}
          </button>
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

function DownloadIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

/**
 * Small spinning ring shown while {@link MetadataProps.onDownload} is
 * in flight. Animation is purely CSS (`animate-spin` from Tailwind) so
 * we don't need a JS timer running for the duration of the export.
 */
function SpinnerIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  )
}
