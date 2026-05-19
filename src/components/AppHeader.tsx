import {useEffect, useState} from 'react'
import {formatBytes} from '../core/utils/formatBytes'
import type {CompactionMetadata, Persona, TraceSource} from '../core'
import PersonaPicker from './PersonaPicker'
import SettingsPanel, {SettingsCog} from './SettingsPanel'
import type {InputBindingsStore} from './timeline/inputBindingsStore'
import type {LinkedViewportStore} from './timeline/linkedViewportStore'
import type {HoveredPaneStore} from './timeline/hoveredPaneStore'

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
  /**
   * Linked-viewport store, threaded so the header can render the
   * sync-on/off toggle in compare mode. Omitted (or paneCount < 2)
   * suppresses the affordance entirely.
   */
  linkedViewportStore?: LinkedViewportStore | null
  /**
   * Hovered-pane store. Read by the sync toggle handler so re-enabling
   * sync snaps from whichever pane the user's cursor is currently
   * over — falling back to the last-published pane and then to the
   * first pane when nothing is hovered.
   */
  hoveredPaneStore?: HoveredPaneStore
  /**
   * Pane ids in render order (top-to-bottom). Used by the sync
   * toggle as the deterministic fallback source when no pane is
   * hovered and nothing has published yet.
   */
  paneIds?: readonly string[]
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
  linkedViewportStore,
  hoveredPaneStore,
  paneIds,
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
        {linkedViewportStore && panes.length >= 2 && (
          <LinkSyncToggle
            linkedViewportStore={linkedViewportStore}
            hoveredPaneStore={hoveredPaneStore}
            paneIds={paneIds}
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

/**
 * Compare-mode sync toggle. Subscribes to the linked store's
 * enable channel so its icon flips without forcing AppHeader to
 * re-render on every viewport publish.
 *
 * On OFF→ON, picks a "winning" pane (hovered → last published →
 * first) and asks it to republish its current viewport, which
 * snaps the other pane back into alignment. On ON→OFF, panes keep
 * whatever viewport they have and stop pushing updates to each
 * other until the user re-enables.
 */
function LinkSyncToggle({
  linkedViewportStore,
  hoveredPaneStore,
  paneIds,
}: {
  linkedViewportStore: LinkedViewportStore
  hoveredPaneStore?: HoveredPaneStore
  paneIds?: readonly string[]
}) {
  const [enabled, setEnabled] = useState(linkedViewportStore.isEnabled())
  useEffect(() => {
    return linkedViewportStore.subscribeEnabled(setEnabled)
  }, [linkedViewportStore])

  const handleClick = (): void => {
    const next = !enabled
    linkedViewportStore.setEnabled(next)
    if (next) {
      const hovered = hoveredPaneStore?.get() ?? null
      const last = linkedViewportStore.lastSourcePaneId()
      const fallback = paneIds && paneIds.length > 0 ? paneIds[0] : null
      const target = hovered ?? last ?? fallback
      if (target !== null) linkedViewportStore.requestResyncFrom(target)
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={enabled ? 'Disable timeline sync' : 'Enable timeline sync'}
      aria-pressed={enabled}
      title={
        enabled
          ? 'Sync on — pan/zoom propagates to the other pane (fraction of trace)'
          : 'Sync off — pan/zoom each pane independently'
      }
      data-testid="link-sync-toggle"
      data-enabled={enabled ? 'true' : 'false'}
      className={
        'cursor-pointer rounded-lg border bg-transparent p-1.5 transition-colors ' +
        (enabled
          ? 'border-[#667eea] text-[#667eea] hover:border-[#a3bffa] hover:text-[#a3bffa]'
          : 'border-[#4a5568] text-[#a0aec0] hover:border-[#667eea] hover:text-[#667eea]')
      }
    >
      {enabled ? <ChainLinkIcon /> : <ChainBrokenIcon />}
    </button>
  )
}

function ChainLinkIcon() {
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
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

function ChainBrokenIcon() {
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
      <path d="M9 17H7A5 5 0 0 1 7 7h2" />
      <path d="M15 7h2a5 5 0 0 1 4 8" />
      <line x1="8" y1="12" x2="12" y2="12" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
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
