import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {CompactionReport, Timeline} from '../core'
import type {SelectionState, SelectionStore} from './timeline/selectionStore'
import {
  hasCallstackSelection,
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

// Height of the panel in CSS pixels. Drag-to-resize is clamped inside
// this range so the pane never collapses to nothing (losing the grip)
// or crowds the timeline out of view.
const DEFAULT_HEIGHT_PX = 200
const MIN_HEIGHT_PX = 80
const MAX_HEIGHT_VH = 0.8
const HEIGHT_STORAGE_KEY = 'perfectto.aggregator.height'

function readPersistedHeight(): number {
  if (typeof window === 'undefined') return DEFAULT_HEIGHT_PX
  try {
    const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY)
    if (!raw) return DEFAULT_HEIGHT_PX
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) return DEFAULT_HEIGHT_PX
    return parsed
  } catch {
    return DEFAULT_HEIGHT_PX
  }
}

function clampHeight(px: number): number {
  const viewportH = typeof window === 'undefined' ? 1000 : window.innerHeight
  const max = Math.max(MIN_HEIGHT_PX + 1, viewportH * MAX_HEIGHT_VH)
  return Math.min(max, Math.max(MIN_HEIGHT_PX, px))
}

/**
 * Bottom panel summarizing the current selection. Surfaces two pieces of
 * information:
 *
 *  - The committed time-range duration (drag-select semantics).
 *  - A root→leaf callstack for the sticky `selectedSlice` when that
 *    slice carries a callsite attribution. The callstack is reconstructed
 *    on demand by walking `SliceBuffers.parentIndex` so we don't pay the
 *    memory cost of storing a per-event stack snapshot. The UI stays
 *    agnostic to the attribution's producer (V8 CPU profile, native
 *    sampler, …) — anything a parser tags as `{kind: 'callsite'}` renders
 *    here.
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

  const showCallstack = hasCallstackSelection(resolved)

  // Drag-to-resize: the panel anchors at the bottom of its flex-col
  // container and the drag handle at its top adjusts the panel's height.
  // Height is persisted per-user so reopening a trace keeps the layout.
  const [height, setHeight] = useState<number>(() =>
    clampHeight(readPersistedHeight()),
  )
  const dragStateRef = useRef<{startY: number; startHeight: number} | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(height))
    } catch {
      // Private browsing / storage disabled — ignore.
    }
  }, [height])

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Only primary button. Capture the pointer so the drag survives
      // moving outside the 6px handle strip.
      if (event.button !== 0) return
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragStateRef.current = {startY: event.clientY, startHeight: height}
    },
    [height],
  )

  const onHandlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragStateRef.current
      if (!drag) return
      // Pointer moves down => panel shrinks (since the handle sits at
      // the top of the panel and the panel is anchored at the bottom).
      const delta = event.clientY - drag.startY
      setHeight(clampHeight(drag.startHeight - delta))
    },
    [],
  )

  const onHandlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragStateRef.current) return
      dragStateRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    },
    [],
  )

  const onHandleDoubleClick = useCallback(() => {
    setHeight(clampHeight(DEFAULT_HEIGHT_PX))
  }, [])

  return (
    <section
      aria-label="Aggregator"
      className="relative flex flex-col border-t border-[#2d3748] bg-[#1a202c]"
      style={{height: `${height}px`, flex: `0 0 ${height}px`}}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize aggregator panel"
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-ns-resize select-none touch-none"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onDoubleClick={onHandleDoubleClick}
        data-testid="aggregator-resize-handle"
      >
        <div className="pointer-events-none mx-auto mt-[3px] h-[2px] w-10 rounded-full bg-[#4a5568]" />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
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
        {showCallstack ? <CallstackView resolved={resolved} /> : null}
      </div>
    </section>
  )
}

interface CallstackViewProps {
  resolved: ResolvedCallstack
}

/**
 * Renders the callstack root → leaf. Only frames whose measure carries a
 * `callsite` attribution are shown; host wrappers (`FunctionCall`, task
 * runners, B/E/X ancestry) are filtered out so the view shows the
 * classic source-land stack users expect from a profiler. The leaf frame
 * is emphasized so users can see which function they actually clicked.
 */
function CallstackView({resolved}: CallstackViewProps) {
  const callsiteFrames = resolved.frames.filter(
    f => f.attribution?.kind === 'callsite',
  )
  const leafFrame = resolved.frames[resolved.leafIndex]
  const durationMs = leafFrame
    ? leafFrame.measure.end - leafFrame.measure.start
    : null
  // A compacted leaf represents many source events. Surface that count
  // explicitly so users don't think they're looking at a single 1ms
  // event that was actually 10k folded sub-ms events.
  const compaction = leafFrame?.measure.compaction?.[0]

  return (
    <div className="mt-3" data-testid="aggregator-callstack">
      <div className="flex items-baseline justify-between">
        <h4 className="text-[10px] font-semibold uppercase tracking-wide text-[#a0aec0]">
          Callstack
        </h4>
        <div className="flex items-baseline gap-2">
          {compaction ? (
            <span
              className="rounded border border-[#f6ad55]/40 bg-[#f6ad55]/10 px-1.5 py-0.5 font-mono text-[10px] text-[#f6ad55]"
              title={compactionTooltip(compaction)}
              data-testid="aggregator-compaction-pill"
            >
              {compactionPillLabel(compaction)}
            </span>
          ) : null}
          {durationMs !== null ? (
            <span className="text-[10px] text-[#718096]">
              leaf{' '}
              <span className="font-mono text-[#f6e05e]">
                {formatDuration(durationMs)}
              </span>
            </span>
          ) : null}
        </div>
      </div>
      {callsiteFrames.length === 0 ? (
        <p className="mt-2 text-xs text-[#718096]">
          No attributed frames in ancestor chain.
        </p>
      ) : (
        <ol
          className="mt-2 flex flex-col gap-0.5 font-mono text-[11px] text-[#e2e8f0]"
          data-testid="aggregator-callstack-list"
        >
          {callsiteFrames.map((frame, idx) => {
            const isLeaf = frame === leafFrame
            const location = frameLocation(frame)
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
                {location ? (
                  <span className="ml-2 text-[10px] text-[#718096]">
                    {location}
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

/**
 * Pill label for a folded leaf. Subpixel-subtree folds carry a depth
 * dimension (the cull collapses entire stacks), so we surface that when
 * present — "≈N frames · ≤D deep". Sibling/CPU-tiny folds stay flat.
 */
function compactionPillLabel(c: CompactionReport): string {
  if (c.origin === 'subpixel-subtree') {
    const depth = c.maxDepthFolded
    if (depth && depth > 1) {
      return `${c.count.toLocaleString()} folded · ≤${depth} deep`
    }
    return `${c.count.toLocaleString()} folded subtree`
  }
  return `${c.count.toLocaleString()} folded`
}

function compactionTooltip(c: CompactionReport): string {
  switch (c.origin) {
    case 'cpu-tiny-frames':
      return 'CPU-profile tiny frames were folded here'
    case 'subpixel-subtree': {
      const depth = c.maxDepthFolded ?? 0
      const distinct = c.distinctNames ?? c.names.length
      const depthSuffix = depth > 1 ? ` (up to ${depth} levels deep)` : ''
      const namesSuffix = distinct > 1 ? ` across ${distinct} distinct names` : ''
      return `Sub-pixel subtree was collapsed at the highest possible point${depthSuffix}${namesSuffix} — the whole subtree was below the cull threshold so individual frames could not have rendered.`
    }
    case 'sibling':
    default:
      return 'Adjacent same-name events were folded here'
  }
}

function frameLabel(frame: CallstackFrame): string {
  const attr = frame.attribution
  if (attr && attr.label.length > 0) return attr.label
  return frame.measure.name || '(anonymous)'
}

function frameLocation(frame: CallstackFrame): string {
  const loc = frame.attribution?.location
  if (!loc?.url) return ''
  const {url, lineNumber, columnNumber} = loc
  if (lineNumber === undefined) return url
  if (columnNumber === undefined) return `${url}:${lineNumber}`
  return `${url}:${lineNumber}:${columnNumber}`
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
