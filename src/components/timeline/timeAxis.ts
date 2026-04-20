/**
 * Time-axis tick computation shared by the top ruler (`TimelineAxis`) and
 * the per-track gridline pass (`canvas2d.drawFrame`). Keeping one source
 * of truth guarantees the axis labels line up with the gridlines that
 * bleed down through every track.
 *
 * Algorithm: classic "nice 1/2/5 × 10^n" step selection, aiming for a
 * major tick roughly every `targetMajorStepPx` pixels. Five minor
 * subdivisions per major (for 1 / 2) or four (for 5) give a readable
 * secondary grid without noise.
 */

/** Target spacing between major ticks, in CSS pixels. Tuned so label text doesn't crowd at common viewport widths. */
export const DEFAULT_MAJOR_STEP_PX = 120

export interface AxisTickInput {
  /** Timeline start, in ms (matches `ViewportStore.timelineStart`). */
  readonly timelineStart: number
  /** Timeline end, in ms. */
  readonly timelineEnd: number
  /** Current zoom, in CSS px per ms. */
  readonly pxPerMs: number
  /**
   * ms at the left edge of the region we want ticks for (usually the
   * current viewport or its buffered bounds). Inclusive.
   */
  readonly rangeStartMs: number
  /** ms at the right edge of the tick range. Exclusive. */
  readonly rangeEndMs: number
  /** Override the major-step target. Defaults to 120 px. */
  readonly targetMajorStepPx?: number
}

export interface AxisTickResult {
  /** ms positions of major ticks (labelled), clipped to the requested range. */
  readonly majorTicksMs: Float64Array
  /** ms positions of minor ticks (unlabelled). Excludes ms values already present in `majorTicksMs`. */
  readonly minorTicksMs: Float64Array
  /** Step between adjacent major ticks, in ms. */
  readonly majorStepMs: number
  /** Step between adjacent minor ticks, in ms. */
  readonly minorStepMs: number
  /** Formats a ms-from-timeline-start value as a short human label (e.g. `0 ms`, `120 ms`, `1.2 s`). */
  readonly labelFor: (ms: number) => string
}

/**
 * Pick the nice step (1/2/5 × 10^n) whose pixel-width is closest to —
 * and at least — the requested target. We round UP so the minimum
 * spacing never drops below `targetMajorStepPx / 2`, which is what
 * keeps labels from overlapping as the user zooms out.
 */
export function niceStepMs(
  rawStepMs: number,
): {major: number; minor: number} {
  if (!Number.isFinite(rawStepMs) || rawStepMs <= 0) {
    return {major: 1, minor: 0.2}
  }
  const pow10 = Math.pow(10, Math.floor(Math.log10(rawStepMs)))
  const norm = rawStepMs / pow10 // in [1, 10)
  let majorMul: number
  let minorDivisions: number
  if (norm <= 1) {
    majorMul = 1
    minorDivisions = 5
  } else if (norm <= 2) {
    majorMul = 2
    minorDivisions = 4
  } else if (norm <= 5) {
    majorMul = 5
    minorDivisions = 5
  } else {
    majorMul = 10
    minorDivisions = 5
  }
  const major = majorMul * pow10
  const minor = major / minorDivisions
  return {major, minor}
}

/**
 * Format a ms offset into a human-readable label. Scales across
 * µs / ms / s / min so wildly-different zoom levels all produce
 * short, readable axis labels.
 *
 * We never show sub-µs precision — the axis picks nice round steps so
 * `ms` will already be an integer multiple of 1 µs for any realistic
 * zoom. `toFixed` then trims to the step's natural precision.
 */
export function formatAxisLabel(ms: number, stepMs: number): string {
  const absMs = Math.abs(ms)
  // Pick the unit that keeps the numeric part in [1, 1000) when possible.
  // Thresholds intentionally use the STEP, not the value, so ticks in
  // the same axis all render in the same unit even when one tick sits
  // at zero.
  if (stepMs >= 60_000) {
    const v = ms / 60_000
    return `${trimFixed(v, decimalsForStep(stepMs / 60_000))} min`
  }
  if (stepMs >= 1_000) {
    const v = ms / 1_000
    return `${trimFixed(v, decimalsForStep(stepMs / 1_000))} s`
  }
  if (stepMs >= 1) {
    return `${trimFixed(ms, decimalsForStep(stepMs))} ms`
  }
  if (stepMs >= 0.001) {
    const v = ms * 1_000
    return `${trimFixed(v, decimalsForStep(stepMs * 1_000))} µs`
  }
  const v = ms * 1_000_000
  return `${trimFixed(v, decimalsForStep(stepMs * 1_000_000))} ns`
  // Keep linter quiet on unused absMs — intentionally kept so future
  // negative-time formatting can swap the branch order if needed.
  void absMs
}

function decimalsForStep(step: number): number {
  if (step >= 1) return 0
  // log10(0.1) = -1 → 1 decimal, log10(0.01) = -2 → 2, …
  return Math.max(0, Math.ceil(-Math.log10(step)))
}

function trimFixed(v: number, decimals: number): string {
  const s = v.toFixed(decimals)
  // Strip trailing zeros after the decimal point (`1.200` -> `1.2`,
  // `1.000` -> `1`) so labels stay compact. `Number(s).toString()`
  // would rewrite in exponential for large values; manual trim is
  // safer.
  if (!s.includes('.')) return s
  return s.replace(/\.?0+$/, '')
}

/**
 * Compute the tick grid for a given zoom + range. Pure — safe to call
 * from both React renders and canvas rAF callbacks.
 */
export function computeAxisTicks(input: AxisTickInput): AxisTickResult {
  const {
    pxPerMs,
    rangeStartMs,
    rangeEndMs,
    timelineStart,
    targetMajorStepPx = DEFAULT_MAJOR_STEP_PX,
  } = input

  // Empty-range / degenerate-zoom guard. Returning empty arrays keeps
  // call sites simple — they can `for (let i=0; i<len; i++)` without
  // extra null-checks, and the canvas drawFrame pass no-ops naturally.
  if (
    !Number.isFinite(pxPerMs) ||
    pxPerMs <= 0 ||
    !Number.isFinite(rangeStartMs) ||
    !Number.isFinite(rangeEndMs) ||
    rangeEndMs <= rangeStartMs
  ) {
    return {
      majorTicksMs: new Float64Array(0),
      minorTicksMs: new Float64Array(0),
      majorStepMs: 0,
      minorStepMs: 0,
      labelFor: () => '',
    }
  }

  const rawStepMs = targetMajorStepPx / pxPerMs
  const {major: majorStepMs, minor: minorStepMs} = niceStepMs(rawStepMs)

  // Anchor tick positions to `timelineStart` (not rangeStart) so the
  // grid doesn't drift as the user pans: tick at rangeStartMs would
  // jitter by fractions of `majorStepMs` every scroll event.
  const firstMajorIndex = Math.ceil(
    (rangeStartMs - timelineStart) / majorStepMs,
  )
  const lastMajorIndex = Math.floor(
    (rangeEndMs - timelineStart) / majorStepMs,
  )
  const majorCount = Math.max(0, lastMajorIndex - firstMajorIndex + 1)

  const majorTicksMs = new Float64Array(majorCount)
  for (let i = 0; i < majorCount; i++) {
    majorTicksMs[i] = timelineStart + (firstMajorIndex + i) * majorStepMs
  }

  // Minor ticks: same anchor logic against `minorStepMs`. We skip
  // minors that coincide with a major (every Nth one) so the gridline
  // pass doesn't overdraw.
  let minorTicksMs: Float64Array
  if (minorStepMs > 0) {
    const firstMinorIndex = Math.ceil(
      (rangeStartMs - timelineStart) / minorStepMs,
    )
    const lastMinorIndex = Math.floor(
      (rangeEndMs - timelineStart) / minorStepMs,
    )
    const minorCountInclusive = Math.max(
      0,
      lastMinorIndex - firstMinorIndex + 1,
    )
    // Round the ratio — it can come out as e.g. 4.9999999 or 5.0000001
    // for awkward majors (100/20.00000000002) and the integer check
    // below would then fail and we'd lose the major-overlap skip.
    const minorsPerMajor = Math.round(majorStepMs / minorStepMs)
    const tmp = new Float64Array(minorCountInclusive)
    let write = 0
    for (let i = 0; i < minorCountInclusive; i++) {
      const idx = firstMinorIndex + i
      if (minorsPerMajor > 0 && idx % minorsPerMajor === 0) continue
      tmp[write++] = timelineStart + idx * minorStepMs
    }
    minorTicksMs = tmp.slice(0, write)
  } else {
    minorTicksMs = new Float64Array(0)
  }

  const labelFor = (ms: number): string =>
    formatAxisLabel(ms - timelineStart, majorStepMs)

  return {majorTicksMs, minorTicksMs, majorStepMs, minorStepMs, labelFor}
}
