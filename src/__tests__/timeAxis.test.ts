import {
  DEFAULT_MAJOR_STEP_PX,
  computeAxisTicks,
  formatAxisLabel,
  niceStepMs,
} from '../components/timeline/timeAxis'

describe('niceStepMs', () => {
  test.each([
    [0.3, 0.5],
    [0.7, 1],
    [1.3, 2],
    [3.7, 5],
    [7, 10],
    [42, 50],
    [120, 200],
    [600, 1000],
    [3_500, 5_000],
    [30_000, 50_000],
  ])('rounds raw step %p up to nice major %p', (raw, expected) => {
    expect(niceStepMs(raw).major).toBeCloseTo(expected, 9)
  })

  test('minor is a clean divisor of major', () => {
    for (const raw of [0.01, 0.2, 1, 3, 7, 42, 180, 999, 4_000, 37_000]) {
      const {major, minor} = niceStepMs(raw)
      expect(minor).toBeGreaterThan(0)
      const ratio = major / minor
      expect(Math.abs(ratio - Math.round(ratio))).toBeLessThan(1e-9)
    }
  })

  test('zero / NaN / negative fall back to a safe default', () => {
    expect(niceStepMs(0).major).toBe(1)
    expect(niceStepMs(Number.NaN).major).toBe(1)
    expect(niceStepMs(-5).major).toBe(1)
  })
})

describe('formatAxisLabel', () => {
  // The unit is chosen by the STEP, not the value, so every tick on a
  // given axis shares a single suffix (e.g. `800 ms`, `1000 ms`, `1200
  // ms` rather than mixing `800 ms` / `1 s` / `1.2 s`). Decimal
  // precision follows the step's natural precision in the chosen unit.
  test.each<[number, number, string]>([
    // ms-unit axes (step < 1 s).
    [0, 100, '0 ms'],
    [250, 100, '250 ms'],
    [1_500, 500, '1500 ms'],
    [1_000, 200, '1000 ms'],
    // s-unit axes (step ≥ 1 s).
    [0, 1_000, '0 s'],
    [1_000, 1_000, '1 s'],
    [2_000, 1_000, '2 s'],
    [500, 500, '500 ms'],
    [1_500, 500, '1500 ms'],
    [2_500, 500, '2500 ms'],
    // min-unit axes.
    [60_000, 60_000, '1 min'],
    [120_000, 60_000, '2 min'],
    [300_000, 300_000, '5 min'],
    // µs-unit axes.
    [0.5, 0.5, '500 µs'],
    [0.001, 0.001, '1 µs'],
    [0.2, 0.2, '200 µs'],
    // ns-unit axes.
    [0.0005, 0.0001, '500 ns'],
    [0.000001, 0.0000001, '1 ns'],
  ])('formats ms=%p step=%p as %p', (ms, step, expected) => {
    expect(formatAxisLabel(ms, step)).toBe(expected)
  })

  test('drops trailing zeros', () => {
    expect(formatAxisLabel(1_000, 1_000)).toBe('1 s')
    expect(formatAxisLabel(2_000, 1_000)).toBe('2 s')
    expect(formatAxisLabel(2_500, 500)).toBe('2500 ms')
  })

  test('nice-step labels with fractional units come out clean', () => {
    // Nice steps produce {1,2,5} × 10^n only, so after unit conversion
    // ALL labels are integer multiples of {0.1, 0.2, 0.5, 1} in the new
    // unit. Here we spot-check the realistic cases the axis emits.
    expect(formatAxisLabel(500, 500)).toBe('500 ms') // 500 ms step -> ms
    expect(formatAxisLabel(2_000, 2_000)).toBe('2 s') // 2 s step -> s
    expect(formatAxisLabel(5_000, 5_000)).toBe('5 s') // 5 s step -> s
    expect(formatAxisLabel(500, 100)).toBe('500 ms')
  })
})

describe('computeAxisTicks', () => {
  const base = {
    timelineStart: 1_000,
    timelineEnd: 2_000,
    pxPerMs: 1, // 1 px per ms → 120 ms target step → nice 200 ms
    rangeStartMs: 1_000,
    rangeEndMs: 2_000,
  } as const

  test('emits major ticks anchored at timelineStart (never at rangeStart)', () => {
    // Pan the range past timelineStart: ticks must still land on
    // timelineStart + k*step (i.e. 1000, 1200, 1400, ...), not on
    // 1050 + k*step.
    const ticks = computeAxisTicks({
      ...base,
      rangeStartMs: 1_050,
      rangeEndMs: 1_850,
    })
    expect(ticks.majorStepMs).toBe(200)
    expect(Array.from(ticks.majorTicksMs)).toEqual([1_200, 1_400, 1_600, 1_800])
  })

  test('includes exact boundary ticks (range inclusive-exclusive)', () => {
    const ticks = computeAxisTicks({
      ...base,
      rangeStartMs: 1_000,
      rangeEndMs: 2_000.0001,
    })
    expect(ticks.majorTicksMs[0]).toBe(1_000)
    expect(ticks.majorTicksMs[ticks.majorTicksMs.length - 1]).toBe(2_000)
  })

  test('minor ticks subdivide the major step and skip coincident majors', () => {
    const ticks = computeAxisTicks(base)
    expect(ticks.majorStepMs).toBe(200)
    expect(ticks.minorStepMs).toBe(50) // 200/4 for the `2 × 10^n` branch
    const majors = new Set(Array.from(ticks.majorTicksMs))
    for (let i = 0; i < ticks.minorTicksMs.length; i++) {
      expect(majors.has(ticks.minorTicksMs[i])).toBe(false)
    }
  })

  test('degenerate inputs return empty arrays without throwing', () => {
    const t1 = computeAxisTicks({...base, pxPerMs: 0})
    expect(t1.majorTicksMs.length).toBe(0)
    expect(t1.minorTicksMs.length).toBe(0)
    expect(t1.labelFor(123)).toBe('')

    const t2 = computeAxisTicks({...base, rangeEndMs: base.rangeStartMs})
    expect(t2.majorTicksMs.length).toBe(0)
    expect(t2.minorTicksMs.length).toBe(0)

    const t3 = computeAxisTicks({
      ...base,
      pxPerMs: Number.NaN,
    })
    expect(t3.majorTicksMs.length).toBe(0)
  })

  test('zooming in shrinks step to keep major spacing near the target', () => {
    // 5 px/ms → target 120 / 5 = 24 ms → nice 50 ms
    const zoomed = computeAxisTicks({...base, pxPerMs: 5})
    expect(zoomed.majorStepMs).toBe(50)
    // 0.1 px/ms → target 120 / 0.1 = 1200 ms → nice 2000 ms
    const zoomedOut = computeAxisTicks({
      ...base,
      pxPerMs: 0.1,
      rangeEndMs: 11_000,
    })
    expect(zoomedOut.majorStepMs).toBe(2_000)
  })

  test('target step override affects density', () => {
    const dense = computeAxisTicks({...base, targetMajorStepPx: 30})
    const sparse = computeAxisTicks({
      ...base,
      targetMajorStepPx: DEFAULT_MAJOR_STEP_PX * 2,
    })
    expect(dense.majorStepMs).toBeLessThan(sparse.majorStepMs)
  })

  test('labelFor is relative to timelineStart', () => {
    const ticks = computeAxisTicks(base)
    // At pxPerMs=1 + default target=120, the nice step is 200 ms, so
    // labels stay in the ms unit across the whole axis.
    expect(ticks.majorStepMs).toBe(200)
    expect(ticks.labelFor(1_000)).toBe('0 ms')
    expect(ticks.labelFor(1_200)).toBe('200 ms')
    expect(ticks.labelFor(2_000)).toBe('1000 ms')
  })

  test('labelFor switches unit once the step crosses 1 s', () => {
    // Zoom out so pxPerMs=0.02 -> target 6000 ms -> nice 10_000 ms
    // (10 s). Labels should then render in seconds.
    const ticks = computeAxisTicks({
      timelineStart: 0,
      timelineEnd: 120_000,
      pxPerMs: 0.02,
      rangeStartMs: 0,
      rangeEndMs: 120_000,
    })
    expect(ticks.majorStepMs).toBe(10_000)
    expect(ticks.labelFor(0)).toBe('0 s')
    expect(ticks.labelFor(30_000)).toBe('30 s')
    expect(ticks.labelFor(90_000)).toBe('90 s')
  })
})
