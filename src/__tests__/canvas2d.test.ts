import type {Measure, Track} from '../core'
import {drawFrame, __test__} from '../components/timeline/canvas2d'
import {
  EMPTY_MARK_BUFFERS,
  buildSliceBuffers,
  buildSliceMipmap,
  pickMipmapLevel,
} from '../core/render/sliceBuffers'

function m(id: string, start: number, end: number, children: Measure[] = [], color?: string): Measure {
  return {id, name: id, start, end, color, events: [], marks: [], measures: children}
}

function track(measures: Measure[]): Track {
  return {id: 't', name: 't', marks: [], measures}
}

describe('quantizeAlpha', () => {
  const {quantizeAlpha, ALPHA_STOPS} = __test__

  it('maps singletons to the opaque stop', () => {
    expect(quantizeAlpha(1)).toBe(0)
    expect(quantizeAlpha(0)).toBe(0)
  })

  it('monotonically assigns denser buckets to later stops', () => {
    const stops = [2, 4, 8, 16, 64, 1024].map(quantizeAlpha)
    for (let i = 1; i < stops.length; i++) {
      expect(stops[i]).toBeGreaterThanOrEqual(stops[i - 1])
    }
  })

  it('saturates at the last stop for very dense buckets', () => {
    expect(quantizeAlpha(10_000)).toBe(ALPHA_STOPS.length - 1)
  })
})

describe('cropText', () => {
  const {cropText, measureCache, cropCache} = __test__

  // ctx that returns a stable 7px-per-char width and counts measureText calls
  // so we can verify caches.
  function makeMeasureCtx() {
    let calls = 0
    const ctx = {
      measureText: (s: string) => {
        calls += 1
        return {width: s.length * 7} as TextMetrics
      },
    } as unknown as CanvasRenderingContext2D
    return {ctx, getCalls: () => calls}
  }

  beforeEach(() => {
    measureCache.clear()
    cropCache.clear()
  })

  it('returns the full string when it fits', () => {
    const {ctx} = makeMeasureCtx()
    expect(cropText(ctx, 'hello', 100)).toBe('hello')
  })

  it('truncates with an ellipsis when it does not fit', () => {
    const {ctx} = makeMeasureCtx()
    // 7px/char * 10 chars = 70, plus ellipsis 7 = 77 > 50 → truncates.
    const out = cropText(ctx, 'helloworld', 50)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThan('helloworld'.length + 1)
  })

  it('returns "" when even the ellipsis does not fit', () => {
    const {ctx} = makeMeasureCtx()
    expect(cropText(ctx, 'whatever', 3)).toBe('')
  })

  it('caches full-width measurement across calls', () => {
    const {ctx, getCalls} = makeMeasureCtx()
    cropText(ctx, 'hello', 100)
    const first = getCalls()
    cropText(ctx, 'hello', 100)
    expect(getCalls()).toBe(first) // second call hits the measureCache
  })

  it('caches the cropped result across calls', () => {
    const {ctx, getCalls} = makeMeasureCtx()
    cropText(ctx, 'helloworld', 50)
    const after = getCalls()
    cropText(ctx, 'helloworld', 50)
    expect(getCalls()).toBe(after) // crop cache hit, no new measureText work
  })
})

describe('styleForBatch', () => {
  const {styleForBatch} = __test__

  it('returns an opaque rgb() string at the opaque stop', () => {
    expect(styleForBatch(0xff0000ff, 0)).toBe('rgb(255,0,0)')
  })

  it('applies fractional alpha for merged buckets', () => {
    const css = styleForBatch(0xff0000ff, 1)
    expect(css).toMatch(/^rgba\(255,0,0,0\./)
  })
})

describe('drawFrame', () => {
  interface FillRectCall {
    x: number
    y: number
    w: number
    h: number
    fillStyle: string
  }

  function makeCtx(): {
    ctx: CanvasRenderingContext2D
    fills: FillRectCall[]
    fillStyleAssignments: string[]
  } {
    const fills: FillRectCall[] = []
    const fillStyleAssignments: string[] = []
    let fillStyle = ''
    const ctx = {
      get fillStyle() {
        return fillStyle
      },
      set fillStyle(v: string) {
        fillStyle = v
        fillStyleAssignments.push(v)
      },
      clearRect: (_x: number, _y: number, _w: number, _h: number): void => {},
      fillRect: (x: number, y: number, w: number, h: number): void => {
        fills.push({x, y, w, h, fillStyle})
      },
    } as unknown as CanvasRenderingContext2D
    return {ctx, fills, fillStyleAssignments}
  }

  it('reads from a SliceBuffers when no mipmap is provided', () => {
    const base = buildSliceBuffers(track([m('a', 0, 100, [], '#ff0000')]))
    const {ctx, fills} = makeCtx()
    drawFrame({
      ctx,
      slices: base,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 200,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
    })
    expect(fills.length).toBe(1)
    expect(fills[0].fillStyle).toBe('rgb(255,0,0)')
  })

  it('batches by (color, alphaStop) and applies density alpha to merged buckets', () => {
    // Dense sub-pixel run — everything merges into one bucket at the finest
    // level, so we should see exactly one fillRect with a fractional alpha.
    const children: Measure[] = []
    for (let i = 0; i < 50; i++) {
      children.push(m(`s${i}`, i * 0.01, i * 0.01 + 0.005, [], '#ff0000'))
    }
    const base = buildSliceBuffers(track(children))
    const mm = buildSliceMipmap(base)
    expect(mm.levels.length).toBeGreaterThan(0)
    const finest = mm.levels[0]
    expect(finest.count).toBe(1)
    expect(finest.counts[0]).toBeGreaterThan(1)

    const {ctx, fills, fillStyleAssignments} = makeCtx()
    drawFrame({
      ctx,
      slices: finest,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 200,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 200,
      visibleStartMs: 0,
      visibleEndMs: 1,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
    })
    expect(fills.length).toBe(1)
    expect(fills[0].fillStyle).toMatch(/^rgba\(255,0,0,0\./)
    // Only one distinct fillStyle was assigned (no per-slice churn).
    expect(fillStyleAssignments.length).toBe(1)
  })

  it('keeps rendering sub-ms measure tracks when the picker transitions past the finest level', () => {
    // Regression for the Chrome_ChildIOThread case: every measure is ~0.017ms
    // wide. At fit-zoom (pxPerMs<1) the mipmap merges them into visible
    // density buckets. When the user zooms in one click past pxPerMs=2 (the
    // finest level's threshold), the picker must still return a mipmap
    // level — falling back to raw base would cull every 0.017ms slice as a
    // sub-pixel singleton and the whole row would vanish.
    const children: Measure[] = []
    for (let i = 0; i < 360; i++) {
      children.push(m(`s${i}`, i * 0.2, i * 0.2 + 0.017))
    }
    const base = buildSliceBuffers(track(children))
    const mm = buildSliceMipmap(base)

    // Simulate the "one click in past the finest level" state the user hit.
    const picked = pickMipmapLevel(mm, 3)
    expect(picked).not.toBe(base)

    const {ctx, fills} = makeCtx()
    drawFrame({
      ctx,
      slices: picked,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 400,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 3,
      visibleStartMs: 0,
      visibleEndMs: 75,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
    })
    expect(fills.length).toBeGreaterThan(0)
  })

  it('renders a label via fillText for wide singletons with baseMeasures', () => {
    const base = buildSliceBuffers(track([m('myWideMeasure', 0, 100)]))
    const fillTextCalls: Array<{text: string; x: number; y: number}> = []
    const ctx = {
      get fillStyle() {
        return ''
      },
      set fillStyle(_v: string) {},
      set font(_v: string) {},
      set textBaseline(_v: CanvasTextBaseline) {},
      clearRect: (_x: number, _y: number, _w: number, _h: number): void => {},
      fillRect: (_x: number, _y: number, _w: number, _h: number): void => {},
      fillText: (text: string, x: number, y: number): void => {
        fillTextCalls.push({text, x, y})
      },
      // Realistic enough for the label gate: 7px per char keeps short names
      // fitting inside a 100px rect without truncation.
      measureText: (s: string) => ({width: s.length * 7}) as TextMetrics,
    } as unknown as CanvasRenderingContext2D

    drawFrame({
      ctx,
      slices: base,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 200,
      heightCss: 22,
      rowHeight: 22,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      baseMeasures: base.measures,
    })

    expect(fillTextCalls.length).toBe(1)
    expect(fillTextCalls[0].text).toBe('myWideMeasure')
  })

  it('skips labels for narrow singletons (below LABEL_MIN_WIDTH_PX)', () => {
    const base = buildSliceBuffers(track([m('tiny', 0, 5)]))
    let fillTextCalls = 0
    const ctx = {
      get fillStyle() {
        return ''
      },
      set fillStyle(_v: string) {},
      set font(_v: string) {},
      set textBaseline(_v: CanvasTextBaseline) {},
      clearRect: (_x: number, _y: number, _w: number, _h: number): void => {},
      fillRect: (_x: number, _y: number, _w: number, _h: number): void => {},
      fillText: (): void => {
        fillTextCalls += 1
      },
      measureText: (s: string) => ({width: s.length * 7}) as TextMetrics,
    } as unknown as CanvasRenderingContext2D

    // 5ms × 2 px/ms = 10px wide — below the 18px label gate.
    drawFrame({
      ctx,
      slices: base,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 200,
      heightCss: 22,
      rowHeight: 22,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 5,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      baseMeasures: base.measures,
    })

    expect(fillTextCalls).toBe(0)
  })

  it('does not label merged mipmap buckets even when wide', () => {
    const children: Measure[] = []
    for (let i = 0; i < 50; i++) {
      children.push(m(`s${i}`, i * 0.01, i * 0.01 + 0.005))
    }
    const base = buildSliceBuffers(track(children))
    const mm = buildSliceMipmap(base)
    const finest = mm.levels[0]
    expect(finest.counts[0]).toBeGreaterThan(1)

    let fillTextCalls = 0
    const ctx = {
      get fillStyle() {
        return ''
      },
      set fillStyle(_v: string) {},
      set font(_v: string) {},
      set textBaseline(_v: CanvasTextBaseline) {},
      clearRect: (_x: number, _y: number, _w: number, _h: number): void => {},
      fillRect: (_x: number, _y: number, _w: number, _h: number): void => {},
      fillText: (): void => {
        fillTextCalls += 1
      },
      measureText: (s: string) => ({width: s.length * 7}) as TextMetrics,
    } as unknown as CanvasRenderingContext2D

    drawFrame({
      ctx,
      slices: finest,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 400,
      heightCss: 22,
      rowHeight: 22,
      pxPerMs: 200,
      visibleStartMs: 0,
      visibleEndMs: 1,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      baseMeasures: base.measures,
    })
    expect(fillTextCalls).toBe(0)
  })

  it('skips sub-pixel singletons but always draws merged buckets', () => {
    // Single 0.4ms slice at pxPerMs=1 is 0.4px wide — singleton, gets culled.
    const singleton = buildSliceBuffers(track([m('tiny', 0, 0.4)]))
    let {ctx, fills} = makeCtx()
    drawFrame({
      ctx,
      slices: singleton,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 100,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 1,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
    })
    expect(fills.length).toBe(0)

    // A merged mipmap bucket covering the same span *never* culls — Phase 2
    // guarantees merged buckets span >= one resolution unit, so they always
    // clear the 1px threshold once pxPerMs matches the level.
    const children: Measure[] = []
    for (let i = 0; i < 10; i++) children.push(m(`s${i}`, i * 0.05, i * 0.05 + 0.01))
    const base = buildSliceBuffers(track(children))
    const mm = buildSliceMipmap(base)
    const finest = mm.levels[0]
    ;({ctx, fills} = makeCtx())
    drawFrame({
      ctx,
      slices: finest,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 100,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 1,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
    })
    expect(fills.length).toBeGreaterThan(0)
  })
})

describe('drawFrame gridlines', () => {
  interface StrokedSegment {
    strokeStyle: string
    moves: Array<[number, number]>
    lines: Array<[number, number]>
  }

  function makeStrokeCtx(): {
    ctx: CanvasRenderingContext2D
    fills: Array<{x: number; y: number; w: number; h: number}>
    strokes: StrokedSegment[]
  } {
    const strokes: StrokedSegment[] = []
    const fills: Array<{x: number; y: number; w: number; h: number}> = []
    let current: StrokedSegment | null = null
    let strokeStyle = ''
    const ctx = {
      set fillStyle(_v: string) {
        /* swallow */
      },
      get fillStyle() {
        return ''
      },
      set strokeStyle(v: string) {
        strokeStyle = v
      },
      get strokeStyle() {
        return strokeStyle
      },
      lineWidth: 1,
      clearRect: (_x: number, _y: number, _w: number, _h: number): void => {},
      fillRect: (x: number, y: number, w: number, h: number): void => {
        fills.push({x, y, w, h})
      },
      beginPath: (): void => {
        current = {strokeStyle, moves: [], lines: []}
      },
      moveTo: (x: number, y: number): void => {
        current?.moves.push([x, y])
      },
      lineTo: (x: number, y: number): void => {
        current?.lines.push([x, y])
      },
      stroke: (): void => {
        if (current) {
          current.strokeStyle = strokeStyle
          strokes.push(current)
          current = null
        }
      },
    } as unknown as CanvasRenderingContext2D
    return {ctx, fills, strokes}
  }

  it('emits one stroke pass per non-empty tick array at the expected x-coords', () => {
    const base = buildSliceBuffers(track([m('a', 0, 100, [], '#ff0000')]))
    const {ctx, strokes} = makeStrokeCtx()

    // Major ticks at 0/50/100 ms; minor at 25/75. At pxPerMs=2 these land
    // on x = 0, 50, 100, 150, 200 respectively. canvasStartMs=0 so the
    // gridlines start at the left edge.
    drawFrame({
      ctx,
      slices: base,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 200,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      majorGridTicksMs: new Float64Array([0, 50, 100]),
      minorGridTicksMs: new Float64Array([25, 75]),
    })

    // Two stroke passes: one for minor, one for major. Minor emits first
    // so major paints on top visually.
    expect(strokes.length).toBe(2)
    const [minor, major] = strokes
    expect(minor.strokeStyle).toMatch(/rgba\(160, 174, 192, 0\.08\)/)
    expect(major.strokeStyle).toMatch(/rgba\(160, 174, 192, 0\.18\)/)

    // Each tick produces one (moveTo, lineTo) pair. `+0.5` pixel snap.
    expect(minor.moves.map(([x]) => x)).toEqual([50.5, 150.5])
    expect(major.moves.map(([x]) => x)).toEqual([0.5, 100.5, 200.5])
    // Full-height vertical strokes.
    for (const seg of strokes) {
      for (let i = 0; i < seg.moves.length; i++) {
        expect(seg.moves[i][1]).toBe(0)
        expect(seg.lines[i][1]).toBe(20)
        expect(seg.moves[i][0]).toBe(seg.lines[i][0])
      }
    }
  })

  it('skips gridline passes when no ticks are provided', () => {
    const base = buildSliceBuffers(track([m('a', 0, 100, [], '#ff0000')]))
    const {ctx, strokes} = makeStrokeCtx()
    drawFrame({
      ctx,
      slices: base,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 200,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
    })
    expect(strokes.length).toBe(0)
  })

  it('culls ticks that lie outside [0, widthCss]', () => {
    const base = buildSliceBuffers(track([m('a', 0, 100, [], '#ff0000')]))
    const {ctx, strokes} = makeStrokeCtx()
    drawFrame({
      ctx,
      slices: base,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 100,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 1,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      // 250 sits past the right edge at x=250, -50 past the left at
      // x=-50, 50 is in-bounds, 0 and 100 are the edges.
      majorGridTicksMs: new Float64Array([-50, 0, 50, 100, 250]),
    })
    expect(strokes.length).toBe(1)
    const xs = strokes[0].moves.map(([x]) => x)
    expect(xs).toEqual([0.5, 50.5, 100.5])
  })

  it('draws gridlines before any fillRect so slices paint on top', () => {
    const base = buildSliceBuffers(track([m('a', 0, 100, [], '#ff0000')]))
    const events: string[] = []
    const ctx = {
      set fillStyle(_v: string) {},
      set strokeStyle(_v: string) {},
      lineWidth: 1,
      clearRect: () => {},
      beginPath: () => events.push('beginPath'),
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => events.push('stroke'),
      fillRect: () => events.push('fillRect'),
    } as unknown as CanvasRenderingContext2D
    drawFrame({
      ctx,
      slices: base,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 200,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      majorGridTicksMs: new Float64Array([50]),
    })
    const firstStroke = events.indexOf('stroke')
    const firstFill = events.indexOf('fillRect')
    expect(firstStroke).toBeGreaterThanOrEqual(0)
    expect(firstFill).toBeGreaterThan(firstStroke)
  })
})
