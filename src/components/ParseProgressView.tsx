import { useEffect, useRef, useState } from 'react'
import type { ParseProgress } from '../core'
import { formatBytes } from '../core/utils/formatBytes'

interface ParseProgressViewProps {
  name: string
  bytesTotal: number
  progress: ParseProgress
  /**
   * Wall-clock time (ms, as returned by `Date.now()`) when parsing
   * started. Used to derive an ETA from the throttled bytes-read rate
   * so large (≥ 500 MB) parses display a remaining-time estimate
   * instead of looking hung.
   */
  startedAt?: number
  onCancel: () => void
}

const ETA_MIN_BYTES = 500 * 1024 * 1024

/**
 * Fraction of the progress bar reserved for the parsing (read+sniff+
 * write-to-parser) phase. The remaining 1 − this is allocated to
 * finalize so the bar still moves through cull/compact/buffer-build
 * — which on a multi-GB trace is genuinely seconds of work.
 */
const PARSING_BAR_FRACTION = 0.85

export default function ParseProgressView({
  name,
  bytesTotal,
  progress,
  startedAt,
  onCancel,
}: ParseProgressViewProps) {
  const { bytesRead, phase, detail, events } = progress
  const hasTotal = bytesTotal > 0

  const fraction = computeProgressFraction({
    phase,
    bytesRead,
    bytesTotal,
    events,
  })
  const percent = Math.min(100, Math.max(0, fraction * 100))

  const status =
    phase === 'done'
      ? 'Finalizing…'
      : phase === 'finalizing'
        ? 'Finalizing…'
        : hasTotal
          ? `Reading ${formatBytes(bytesRead)} of ${formatBytes(bytesTotal)}…`
          : `Reading ${formatBytes(bytesRead)}…`
  // Sub-status from the parser (e.g. "Finalizing Renderer (track 4/12)").
  // Only shown during finalize where it adds signal that the byte
  // counter / progress bar can't.
  const detailText = phase === 'finalizing' && detail ? detail : null

  const etaText = useEta({bytesTotal, bytesRead, phase, startedAt})

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="mb-2 bg-gradient-to-br from-[#667eea] to-[#764ba2] bg-clip-text text-4xl font-bold text-transparent">
        Perfectto
      </h1>
      <p className="mb-8 text-base text-[#718096]">Parsing trace…</p>

      <div className="flex w-full max-w-[640px] flex-col gap-4 rounded-2xl border border-[#2d3748] bg-[rgba(102,126,234,0.04)] p-6">
        <div className="flex items-baseline justify-between gap-4">
          <p className="truncate text-lg font-semibold text-[#e2e8f0]" title={name}>
            {name}
          </p>
          <p className="text-sm tabular-nums text-[#718096]">
            {hasTotal ? `${percent.toFixed(1)}%` : formatBytes(bytesRead)}
          </p>
        </div>

        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={hasTotal ? 100 : undefined}
          aria-valuenow={hasTotal ? percent : undefined}
          aria-label={status}
          className="h-2 w-full overflow-hidden rounded-full bg-[#2d3748]"
        >
          {hasTotal ? (
            <div
              className="h-full bg-gradient-to-r from-[#667eea] to-[#764ba2] transition-[width] duration-150 ease-out"
              style={{ width: `${percent}%` }}
            />
          ) : (
            <div className="h-full w-1/3 animate-pulse bg-gradient-to-r from-[#667eea] to-[#764ba2]" />
          )}
        </div>

        <div className="flex items-baseline justify-between gap-4 text-sm tabular-nums text-[#a0aec0]">
          <span>{status}</span>
          {etaText && <span className="text-xs text-[#718096]">{etaText}</span>}
        </div>
        {/* Always render so the card height is stable when the parser
            starts emitting finalize sub-status mid-parse. */}
        <p
          className="truncate text-xs text-[#718096]"
          title={detailText ?? undefined}
          aria-hidden={detailText ? undefined : true}
        >
          {detailText ?? '\u00a0'}
        </p>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="cursor-pointer rounded-lg border border-[#4a5568] bg-transparent px-4 py-1.5 text-sm text-[#a0aec0] transition-colors hover:border-[#ed8936] hover:text-[#ed8936]"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

interface ProgressFractionArgs {
  phase: ParseProgress['phase']
  bytesRead: number
  bytesTotal: number
  events: ParseProgress['events']
}

/**
 * Maps the worker's `(phase, bytesRead, events)` triple onto a single
 * 0..1 bar position. The parsing phase fills the first
 * {@link PARSING_BAR_FRACTION}; finalize fills the rest, driven by the
 * parser's event-count progress when available and by a "barely
 * moving" indeterminate slope otherwise.
 *
 * Saturating both sides at their respective fractions matters more than
 * exact accuracy — what we're trying to avoid is the bar showing 100%
 * (or worse, 1100%) for the entire 20-second finalize.
 */
function computeProgressFraction({
  phase,
  bytesRead,
  bytesTotal,
  events,
}: ProgressFractionArgs): number {
  if (phase === 'done') return 1
  if (phase === 'parsing') {
    if (bytesTotal <= 0) return 0
    const raw = bytesRead / bytesTotal
    return Math.max(0, Math.min(PARSING_BAR_FRACTION, raw * PARSING_BAR_FRACTION))
  }
  // finalizing
  const finalizeBudget = 1 - PARSING_BAR_FRACTION
  if (events && events.total > 0) {
    const ratio = Math.max(0, Math.min(1, events.processed / events.total))
    // Cap finalize at 0.99 so the bar only ever reaches 100% on `done`.
    return Math.min(0.99, PARSING_BAR_FRACTION + ratio * finalizeBudget * 0.99)
  }
  // No event-count signal yet (parser hasn't emitted one). Sit at the
  // boundary between parsing and finalize so the user can see we
  // crossed phases; the indeterminate stripe (events==null) keeps
  // visual motion via the existing animate-pulse fallback if total=0.
  return PARSING_BAR_FRACTION
}

interface UseEtaArgs {
  bytesTotal: number
  bytesRead: number
  phase: ParseProgress['phase']
  startedAt?: number
}

/**
 * Derive a human-readable "ETA ~Ns" string from the bytes-read rate.
 * Suppressed when:
 *   - the file is smaller than {@link ETA_MIN_BYTES} (ETAs add noise on
 *     sub-second parses);
 *   - we don't have a start timestamp yet;
 *   - we're past the `parsing` phase (finalize doesn't consume bytes, so
 *     the rate stops being meaningful).
 *
 * Samples the rate on a throttle so it doesn't flicker each time the
 * worker emits a progress message.
 */
function useEta({bytesTotal, bytesRead, phase, startedAt}: UseEtaArgs): string | null {
  const lastTick = useRef<{at: number; bytes: number} | null>(null)
  const [etaMs, setEtaMs] = useState<number | null>(null)

  useEffect(() => {
    if (!startedAt) return
    if (bytesTotal < ETA_MIN_BYTES) return
    if (phase !== 'parsing') return
    const now = Date.now()
    const prev = lastTick.current
    // Require a second data point at least 300ms apart so the
    // instantaneous rate isn't dominated by a single pull that happened
    // to coincide with a 64KiB throttle tick.
    if (prev && now - prev.at > 300) {
      const dBytes = bytesRead - prev.bytes
      const dMs = now - prev.at
      if (dBytes > 0 && dMs > 0) {
        const rate = dBytes / dMs
        const remaining = Math.max(0, bytesTotal - bytesRead)
        setEtaMs(remaining / rate)
      }
      lastTick.current = {at: now, bytes: bytesRead}
    } else if (!prev) {
      lastTick.current = {at: now, bytes: bytesRead}
    }
  }, [bytesRead, bytesTotal, phase, startedAt])

  if (etaMs === null) return null
  if (phase !== 'parsing') return null
  return `~${formatEta(etaMs)} remaining`
}

function formatEta(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  return `${min}m ${rem}s`
}
