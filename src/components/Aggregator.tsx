import {useEffect, useState} from 'react'
import type {SelectionStore} from './timeline/selectionStore'

interface AggregatorProps {
  /**
   * Optional selection store. When present, the Aggregator mirrors the
   * committed selection into React state and shows a live readout of
   * the selected range + duration. When absent, falls back to the
   * original placeholder text.
   */
  selectionStore?: SelectionStore
}

/**
 * Bottom panel summarizing the current selection. Full aggregation
 * (top functions / categories / CPU split) is a separate follow-up;
 * this file is intentionally minimal — it exists to prove the
 * selectionStore plumbing reaches the Aggregator surface.
 */
export default function Aggregator({selectionStore}: AggregatorProps) {
  const [state, setState] = useState(
    () => selectionStore?.get() ?? {committed: null, inProgress: null},
  )

  useEffect(() => {
    if (!selectionStore) return
    setState(selectionStore.get())
    return selectionStore.subscribe(next => setState(next))
  }, [selectionStore])

  const range = state.committed
  const durationMs = range ? range.endMs - range.startMs : null

  return (
    <section
      aria-label="Aggregator"
      className="border-t border-[#2d3748] bg-[#1a202c] px-6 py-4"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[#a0aec0]">
          Aggregator
        </h3>
        {range && (
          <span className="text-[10px] uppercase tracking-wide text-[#718096]">
            Press Z to zoom · Esc to clear
          </span>
        )}
      </div>
      {range && durationMs !== null ? (
        <p
          className="mt-2 text-xs text-[#e2e8f0]"
          data-testid="aggregator-selection-readout"
        >
          Selection:{' '}
          <span className="font-mono text-[#f6e05e]">
            {formatDuration(durationMs)}
          </span>{' '}
          <span className="text-[#718096]">
            ({formatTimeRange(range.startMs, range.endMs)})
          </span>
        </p>
      ) : (
        <p className="mt-2 text-xs text-[#718096]">
          Drag on the overview or timeline to select a range.
        </p>
      )}
    </section>
  )
}

const MS_PER_S = 1000
const MS_PER_US = 0.001

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms === 0) return '0 ms'
  if (ms < MS_PER_US * 1000) return `${(ms / MS_PER_US).toFixed(0)} µs`
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`
  if (ms < 10) return `${ms.toFixed(2)} ms`
  if (ms < 1000) return `${ms.toFixed(1)} ms`
  return `${(ms / MS_PER_S).toFixed(2)} s`
}

function formatTimeRange(startMs: number, endMs: number): string {
  return `${formatTime(startMs)} – ${formatTime(endMs)}`
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  if (Math.abs(ms) < 1) return `${(ms * 1000).toFixed(0)} µs`
  if (Math.abs(ms) < 1000) return `${ms.toFixed(2)} ms`
  return `${(ms / MS_PER_S).toFixed(3)} s`
}
