import {useEffect, useMemo, useState} from 'react'
import type {Timeline} from '../core'
import type {SelectionState, SelectionStore} from './timeline/selectionStore'
import {
  isJsFrameSelection,
  resolveCallstack,
  type CallstackFrame,
  type ResolvedCallstack,
} from './timeline/callstack'

interface AggregatorProps {
  /**
   * Optional selection store. When present, the Aggregator mirrors the
   * committed selection into React state and shows a live readout of
   * the selected range + duration. When absent, falls back to the
   * original placeholder text.
   */
  selectionStore?: SelectionStore
  /**
   * Parsed trace timeline. Needed so the panel can resolve the sticky
   * `selectedSlice` back to its `Track` / `Measure` and reconstruct the
   * ancestor chain for callstack display. Optional so standalone /
   * smoke uses of the component keep working.
   */
  timeline?: Timeline
}

const INITIAL_STATE: SelectionState = {
  committed: null,
  inProgress: null,
  selectedSlice: null,
  hoveredSlice: null,
}

/**
 * Bottom panel summarizing the current selection. Surfaces two pieces of
 * information:
 *
 *  - The committed time-range duration (drag-select semantics).
 *  - A root→leaf callstack for the sticky `selectedSlice` when that
 *    slice is a V8 JS frame. The callstack is reconstructed on demand
 *    by walking `SliceBuffers.parentIndex` so we don't pay the memory
 *    cost of storing a per-event stack snapshot.
 */
export default function Aggregator({selectionStore, timeline}: AggregatorProps) {
  const [state, setState] = useState<SelectionState>(
    () => selectionStore?.get() ?? INITIAL_STATE,
  )

  useEffect(() => {
    if (!selectionStore) return
    setState(selectionStore.get())
    return selectionStore.subscribe(next => setState(next))
  }, [selectionStore])

  const range = state.committed
  const durationMs = range ? range.endMs - range.startMs : null

  const resolved: ResolvedCallstack = useMemo(() => {
    if (!timeline) {
      return {track: null, frames: [], leafIndex: -1}
    }
    return resolveCallstack(timeline, state.selectedSlice)
  }, [timeline, state.selectedSlice])

  const showCallstack = isJsFrameSelection(resolved)

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
      ) : !showCallstack ? (
        <p className="mt-2 text-xs text-[#718096]">
          Drag on the overview or timeline to select a range.
        </p>
      ) : null}
      {showCallstack ? (
        <CallstackView resolved={resolved} />
      ) : null}
    </section>
  )
}

interface CallstackViewProps {
  resolved: ResolvedCallstack
}

/**
 * Renders the JS-frame callstack root → leaf. Non-JS ancestors
 * (`FunctionCall`, host B/E/X wrappers) are hidden so the view shows the
 * classic script-land stack users expect from a profiler. The leaf frame
 * is emphasized so users can see which function they actually clicked.
 */
function CallstackView({resolved}: CallstackViewProps) {
  const jsFrames = resolved.frames.filter(f => f.isJsFrame)
  const leafFrame = resolved.frames[resolved.leafIndex]
  const durationMs = leafFrame
    ? leafFrame.measure.end - leafFrame.measure.start
    : null

  return (
    <div className="mt-3" data-testid="aggregator-callstack">
      <div className="flex items-baseline justify-between">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[#a0aec0]">
          JS Callstack
        </h4>
        {durationMs !== null ? (
          <span className="text-[10px] text-[#718096]">
            leaf{' '}
            <span className="font-mono text-[#f6e05e]">
              {formatDuration(durationMs)}
            </span>
          </span>
        ) : null}
      </div>
      {jsFrames.length === 0 ? (
        <p className="mt-2 text-xs text-[#718096]">
          No JS frames in ancestor chain.
        </p>
      ) : (
        <ol
          className="mt-2 flex flex-col gap-0.5 font-mono text-[11px] text-[#e2e8f0]"
          data-testid="aggregator-callstack-list"
        >
          {jsFrames.map((frame, idx) => {
            const isLeaf = frame === leafFrame
            return (
              <li
                key={`${frame.measure.id}-${idx}`}
                className={
                  isLeaf
                    ? 'rounded bg-[#2d3748] px-2 py-1 text-[#f6e05e]'
                    : 'px-2 py-0.5 text-[#cbd5e0]'
                }
                data-leaf={isLeaf ? 'true' : undefined}
              >
                <span className="truncate">{frameLabel(frame)}</span>
                {frame.url ? (
                  <span className="ml-2 text-[10px] text-[#718096]">
                    {frameLocation(frame)}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function frameLabel(frame: CallstackFrame): string {
  const name =
    (frame.functionName && frame.functionName.length > 0
      ? frame.functionName
      : frame.measure.name) || '(anonymous)'
  return name
}

function frameLocation(frame: CallstackFrame): string {
  if (!frame.url) return ''
  const line = frame.lineNumber
  const col = frame.columnNumber
  if (line === undefined) return frame.url
  if (col === undefined) return `${frame.url}:${line}`
  return `${frame.url}:${line}:${col}`
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
