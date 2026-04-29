import {useState} from 'react'
import {formatBytes} from '../core/utils/formatBytes'
import type {CompactionMetadata, Persona, TraceSource} from '../core'
import PersonaPicker from './PersonaPicker'
import SettingsPanel, {SettingsCog} from './SettingsPanel'
import type {InputBindingsStore} from './timeline/inputBindingsStore'

/**
 * Minimal pane shape the header needs for the compound title. Mirrors
 * the subset of {@link AggregatorPaneInfo} we care about — name only —
 * so callers can pass either type in without a wider import surface.
 */
export interface AppHeaderPaneInfo {
  /** Display name shown in the compound title (e.g. the trace filename). */
  name: string
}

/**
 * Per-trace metadata surfaced in the global header when only one
 * pane is loaded. At N≥2 these belong on the per-pane
 * {@link TracePaneHeader} instead — there's no single "the trace"
 * to download or label in compare mode — so this prop is omitted by
 * the parent when the comparison view is active.
 */
export interface AppHeaderTraceMeta {
  source: TraceSource
  compaction?: CompactionMetadata
  /** Optional download callback. When omitted the button is hidden. */
  onDownload?: () => Promise<void>
}

interface AppHeaderProps {
  /**
   * Loaded panes (those that already have a parsed trace). Drives the
   * compound title: 1 pane → just its filename; 2 panes →
   * `"a.json vs. b.json"`. Mid-parse panes are intentionally excluded
   * so the title doesn't flicker while the second drop loads.
   */
  panes: readonly AppHeaderPaneInfo[]
  /** Returns to the splash by closing every pane. */
  onBack: () => void
  /**
   * Per-trace metadata for the single-pane view. When provided the
   * header renders size + compaction pill + download button between
   * the title and the persona picker, matching the legacy
   * single-trace UX. Set by {@link App} only when `panes.length === 1`
   * — at N≥2 these live on the per-pane TracePaneHeader instead.
   */
  singlePaneMeta?: AppHeaderTraceMeta
  /**
   * Persona affordance — global across panes. When all three of these
   * are provided the picker renders; otherwise it's omitted (e.g. the
   * brief window between mount and the first successful load when the
   * detected id isn't available yet).
   */
  personas?: readonly Persona[]
  activePersonaId?: string
  detectedPersonaId?: string
  onPersonaChange?: (id: string) => void
  /**
   * Input-bindings store. When provided, the settings cog is shown in
   * the top-right of the header and opens the flipout panel.
   */
  bindingsStore?: InputBindingsStore
}

/**
 * Top-of-app header (one instance, mounted by {@link App}). Hosts the
 * back-to-splash button, the compound trace title, optional per-trace
 * metadata (size/compaction/download — N=1 only), the persona picker,
 * and the settings cog.
 *
 * The compound title degenerates to a single filename when only one
 * pane is loaded, so the same component covers both N=1 and N=2 with
 * no fork. At N=1 the per-trace metadata lives here; at N≥2 it moves
 * to the per-pane {@link TracePaneHeader} instead so two stacked
 * panes don't share a single "size" / "download" affordance.
 */
export default function AppHeader({
  panes,
  onBack,
  singlePaneMeta,
  personas,
  activePersonaId,
  detectedPersonaId,
  onPersonaChange,
  bindingsStore,
}: AppHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const title = compoundTitle(panes)

  const totalFolded = singlePaneMeta?.compaction
    ? (singlePaneMeta.compaction.onlineEventsFolded ?? 0) +
      (singlePaneMeta.compaction.siblingEventsFolded ?? 0) +
      (singlePaneMeta.compaction.cpuTinyEventsFolded ?? 0) +
      (singlePaneMeta.compaction.subpixelEventsFolded ?? 0)
    : 0

  const handleDownloadClick = async (): Promise<void> => {
    const onDownload = singlePaneMeta?.onDownload
    if (!onDownload || downloading) return
    setDownloading(true)
    try {
      await onDownload()
    } catch (err) {
      // Match the per-pane header behavior: log and clear the spinner
      // so a transient failure doesn't lock the button forever.
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
        <h1
          className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[1.1rem] font-semibold text-[#e2e8f0]"
          title={title}
          data-testid="app-header-title"
        >
          {title}
        </h1>
        {singlePaneMeta && (
          <span className="whitespace-nowrap text-xs text-[#718096]">
            {formatBytes(singlePaneMeta.source.size)}
          </span>
        )}
        {singlePaneMeta?.compaction && totalFolded > 0 && (
          <span
            className="whitespace-nowrap rounded border border-[#f6ad55]/40 bg-[#f6ad55]/10 px-2 py-0.5 font-mono text-[10px] text-[#f6ad55]"
            title={
              `Large-trace compaction: ${singlePaneMeta.compaction.siblingEventsFolded.toLocaleString()} sibling · ` +
              `${singlePaneMeta.compaction.cpuTinyEventsFolded.toLocaleString()} cpu-tiny · ` +
              `${singlePaneMeta.compaction.subpixelEventsFolded.toLocaleString()} subpixel-subtree` +
              (singlePaneMeta.compaction.subpixelMaxDepthFolded > 0
                ? ` (≤ ${singlePaneMeta.compaction.subpixelMaxDepthFolded} deep)`
                : '') +
              ` · ${singlePaneMeta.compaction.onlineEventsFolded.toLocaleString()} online` +
              (singlePaneMeta.compaction.onlineTriggered ? ' (streaming cap hit)' : '')
            }
            data-testid="metadata-compaction-pill"
          >
            {totalFolded.toLocaleString()} folded
          </span>
        )}
        {singlePaneMeta?.onDownload && (
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
        {personas && activePersonaId && detectedPersonaId && onPersonaChange && (
          <PersonaPicker
            personas={personas}
            activeId={activePersonaId}
            detectedId={detectedPersonaId}
            onChange={onPersonaChange}
          />
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

/**
 * Build the global header title from the loaded panes.
 *
 *  - 0 panes: app name (briefly visible during the gap between drop
 *    and the first successful load — the splash itself owns its own
 *    branding so this is a fallback only).
 *  - 1 pane: just that trace's filename.
 *  - 2+ panes: filenames joined with `" vs. "` so the user can see at
 *    a glance which traces they're comparing.
 *
 * Long titles fall back to the OS tooltip via the `<h1 title=...>`
 * attribute on the rendered element.
 */
export function compoundTitle(panes: readonly AppHeaderPaneInfo[]): string {
  if (panes.length === 0) return 'Perfectto'
  if (panes.length === 1) return panes[0].name
  return panes.map(p => p.name).join(' vs. ')
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
 * Spinning ring shown while the download promise is in flight. CSS
 * animation only — no JS timers running for the duration of the
 * export.
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
