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

export default function ParseProgressView({
  name,
  bytesTotal,
  progress,
  startedAt,
  onCancel,
}: ParseProgressViewProps) {
  const { bytesRead, phase } = progress
  const hasTotal = bytesTotal > 0
  const percent = hasTotal
    ? Math.min(100, Math.max(0, (bytesRead / bytesTotal) * 100))
    : 0

  const status =
    phase === 'done'
      ? 'Finalizing…'
      : phase === 'finalizing'
        ? 'Finalizing…'
        : hasTotal
          ? `Reading ${formatBytes(bytesRead)} of ${formatBytes(bytesTotal)}…`
          : `Reading ${formatBytes(bytesRead)}…`

  const etaText = useEta({bytesTotal, bytesRead, phase, startedAt})

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="mb-2 bg-gradient-to-br from-[#667eea] to-[#764ba2] bg-clip-text text-4xl font-bold text-transparent">
        Perfectto
      </h1>
      <p className="mb-12 text-base text-[#718096]">Parsing trace…</p>

      <div className="flex w-full max-w-[640px] flex-col gap-5 rounded-2xl border border-[#2d3748] bg-[rgba(102,126,234,0.04)] p-8">
        <div className="flex items-baseline justify-between gap-4">
          <p className="truncate text-lg font-semibold text-[#e2e8f0]" title={name}>
            {name}
          </p>
          <p className="text-sm text-[#718096]">
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

        <div className="flex items-baseline justify-between gap-4 text-sm text-[#a0aec0]">
          <span>{status}</span>
          {etaText && <span className="text-xs text-[#718096]">{etaText}</span>}
        </div>

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
