import type { ParseProgress } from '../core'
import { formatBytes } from '../core/utils/formatBytes'

interface ParseProgressViewProps {
  name: string
  bytesTotal: number
  progress: ParseProgress
  onCancel: () => void
}

export default function ParseProgressView({
  name,
  bytesTotal,
  progress,
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
      : hasTotal
        ? `Reading ${formatBytes(bytesRead)} of ${formatBytes(bytesTotal)}…`
        : `Reading ${formatBytes(bytesRead)}…`

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

        <p className="text-sm text-[#a0aec0]">{status}</p>

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
