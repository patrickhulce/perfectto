import {useState} from 'react'
import {formatBytes} from '../core/utils/formatBytes'
import type {CompactionMetadata, TraceSource} from '../core'

interface TracePaneHeaderProps {
  source: TraceSource
  /**
   * Optional compaction counters from the parser. When non-zero we
   * render a small pill with the same hover tooltip as the legacy
   * Metadata bar.
   */
  compaction?: CompactionMetadata
  /** Removes this pane. */
  onClose: () => void
  /**
   * Optional download callback. When provided, the icon-only download
   * button is shown at the right of the strip.
   */
  onDownload?: () => Promise<void>
}

/**
 * Thin (target ~20 px) per-pane header. Sits directly above the
 * Timeline inside a {@link TracePane} and carries the metadata that
 * is *specific to this trace*: filename, size, compaction pill,
 * close-pane affordance, download button.
 *
 * Global concerns (back-to-splash, persona picker, settings cog) live
 * in {@link AppHeader} instead so the multi-trace comparison view
 * doesn't render two thick header bars on top of each other.
 *
 * Layout: a single `flex h-5` (20 px) row with `text-[11px]` for
 * filename + pills and 14 px square icon buttons. Pills + buttons
 * intentionally drop their vertical padding so everything sits flush
 * on the 20 px line.
 */
export default function TracePaneHeader({
  source,
  compaction,
  onClose,
  onDownload,
}: TracePaneHeaderProps) {
  const totalFolded =
    (compaction?.onlineEventsFolded ?? 0) +
    (compaction?.siblingEventsFolded ?? 0) +
    (compaction?.cpuTinyEventsFolded ?? 0) +
    (compaction?.subpixelEventsFolded ?? 0)
  const [downloading, setDownloading] = useState(false)

  const handleDownloadClick = async (): Promise<void> => {
    if (!onDownload || downloading) return
    setDownloading(true)
    try {
      await onDownload()
    } catch (err) {
      // Match the legacy Metadata behavior: log and clear the spinner
      // so a transient failure doesn't lock the button forever.
      console.error('compacted-trace download failed', err)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div
      data-testid="trace-pane-header"
      className="flex h-5 shrink-0 items-center gap-2 border-b border-[#2d3748] bg-[#0f1420] px-3 text-[11px] leading-none text-[#a0aec0]"
    >
      <h2
        className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-medium text-[#e2e8f0]"
        title={source.name}
      >
        {source.name}
      </h2>
      <span className="whitespace-nowrap text-[10px] text-[#718096]">
        {formatBytes(source.size)}
      </span>
      {compaction && totalFolded > 0 && (
        <span
          className="whitespace-nowrap rounded border border-[#f6ad55]/40 bg-[#f6ad55]/10 px-1.5 font-mono text-[10px] leading-[14px] text-[#f6ad55]"
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
          className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded text-[#a0aec0] transition-colors hover:text-[#667eea] disabled:cursor-wait disabled:opacity-50"
        >
          {downloading ? <SpinnerIcon /> : <DownloadIcon />}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close pane"
        title="Close this trace"
        data-testid="trace-pane-close-button"
        className="flex h-3.5 w-3.5 cursor-pointer items-center justify-center rounded text-[#a0aec0] transition-colors hover:text-[#fc8181]"
      >
        <CloseIcon />
      </button>
    </div>
  )
}

function DownloadIcon() {
  return (
    <svg
      width="12"
      height="12"
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

function CloseIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
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
      width="12"
      height="12"
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
