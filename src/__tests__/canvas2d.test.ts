import type {CompactionReport, Measure, Track} from '../core'
import {drawFrame, drawHighlightFrame, __test__} from '../components/timeline/canvas2d'
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

  it('paints merged buckets at the same opaque color as singletons (alpha lives on globalAlpha)', () => {
    // Dense sub-pixel run — everything merges into one bucket at the finest
    // level. After the dim-flatten change the bucket renders with the base
    // rgb(...) color (no fractional alpha in fillStyle); the dim factor
    // rides on globalAlpha instead, so rows of singletons + merged buckets
    // don't band.
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
    expect(fills[0].fillStyle).toBe('rgb(255,0,0)')
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

describe('drawFrame compaction stripe overlay', () => {
  // Extended ctx mock that records `createPattern` invocations, every
  // `fillStyle` assignment, and `fillRect` calls (with the current
  // fillStyle). This lets us verify the stripe overlay pass:
  //   1. asks the renderer for a CanvasPattern (or falls back to a flat
  //      tint when `createPattern` is absent);
  //   2. assigns the stripe fill exactly once per draw, after the color
  //      batches paint;
  //   3. only fillRects flagged slices.
  interface StripeFill {
    x: number
    y: number
    w: number
    h: number
    fillStyle: string
  }
  interface StripeCtxOptions {
    /** Return null from `createPattern`, simulating jsdom. */
    nullPattern?: boolean
    /** Omit `createPattern` entirely. */
    omitCreatePattern?: boolean
  }
  function makeStripeCtx(opts: StripeCtxOptions = {}): {
    ctx: CanvasRenderingContext2D
    fills: StripeFill[]
    fillStyleAssignments: Array<string | object>
    getCreatePatternCalls: () => number
  } {
    const fills: StripeFill[] = []
    const fillStyleAssignments: Array<string | object> = []
    let fillStyle: string | object = ''
    let createPatternCalls = 0
    const fakePattern = {marker: 'stripe-pattern'}
    const base: Record<string, unknown> = {
      get fillStyle() {
        return fillStyle
      },
      set fillStyle(v: string | object) {
        fillStyle = v
        fillStyleAssignments.push(v)
      },
      clearRect: (_x: number, _y: number, _w: number, _h: number): void => {},
      fillRect: (x: number, y: number, w: number, h: number): void => {
        fills.push({
          x,
          y,
          w,
          h,
          fillStyle: typeof fillStyle === 'string' ? fillStyle : '<pattern>',
        })
      },
    }
    if (!opts.omitCreatePattern) {
      base.createPattern = (): unknown => {
        createPatternCalls += 1
        return opts.nullPattern ? null : fakePattern
      }
    }
    const ctx = base as unknown as CanvasRenderingContext2D
    return {
      ctx,
      fills,
      fillStyleAssignments,
      getCreatePatternCalls: () => createPatternCalls,
    }
  }

  /**
   * Minimal `OffscreenCanvas` stub. jsdom doesn't ship one, so the
   * production code path that builds the stripe pattern bails to the
   * fallback tint when we don't install this. The stub returns a
   * `null` 2d context (the test cares about the `createPattern` call
   * on the *outer* ctx, not the offscreen drawing).
   */
  class StubOffscreenCanvas {
    public width: number
    public height: number
    constructor(w: number, h: number) {
      this.width = w
      this.height = h
    }
    getContext(): null {
      return null
    }
  }

  let originalOffscreenCanvas: unknown
  beforeEach(() => {
    // Pattern cache is keyed by ctx identity, but we use a fresh ctx
    // per test anyway. Cropping caches don't matter here.
    __test__.measureCache.clear()
    __test__.cropCache.clear()
    originalOffscreenCanvas = (globalThis as Record<string, unknown>).OffscreenCanvas
    ;(globalThis as Record<string, unknown>).OffscreenCanvas = StubOffscreenCanvas
  })

  afterEach(() => {
    ;(globalThis as Record<string, unknown>).OffscreenCanvas = originalOffscreenCanvas
  })

  function compactedTrack(): Track {
    const compactionReport: CompactionReport = {
      origin: 'subpixel-subtree',
      category: 'js',
      names: ['frame0'],
      count: 99,
      firstTs: 0,
      lastTs: 100,
      totalDurationMs: 100,
      maxDepthFolded: 99,
    }
    const folded: Measure = {
      id: 'folded',
      name: 'folded',
      start: 0,
      end: 100,
      events: [],
      marks: [],
      measures: [],
      compaction: [compactionReport],
    }
    return {id: 't', name: 't', marks: [], measures: [folded]}
  }

  it('does not paint the stripe overlay when no slice carries the compacted flag', () => {
    const base = buildSliceBuffers(track([m('plain', 0, 100, [], '#ff0000')]))
    const {ctx, fills, fillStyleAssignments, getCreatePatternCalls} = makeStripeCtx()
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
    expect(getCreatePatternCalls()).toBe(0)
    // Only the color batch's fillStyle should have been assigned —
    // no pattern, no fallback tint.
    for (const v of fillStyleAssignments) expect(typeof v).toBe('string')
  })

  it('paints exactly one stripe overlay rect per compacted slice, after the color batch', () => {
    const base = buildSliceBuffers(compactedTrack())
    const {ctx, fills, fillStyleAssignments} = makeStripeCtx()
    drawFrame({
      ctx,
      slices: base,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 400,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
    })
    // Two fillRects: first the color batch, then the stripe overlay
    // at the same geometry. Order matters — the stripe must be on
    // top of the color, otherwise the color would mask it.
    expect(fills.length).toBe(2)
    expect(fills[0].x).toBe(fills[1].x)
    expect(fills[0].y).toBe(fills[1].y)
    expect(fills[0].w).toBe(fills[1].w)
    expect(fills[0].h).toBe(fills[1].h)
    // Color batch first (rgb...), stripe second (<pattern> in our mock).
    expect(typeof fills[0].fillStyle).toBe('string')
    expect(fills[0].fillStyle.startsWith('rgb')).toBe(true)
    expect(fills[1].fillStyle).toBe('<pattern>')
    // The stripe pass should assign fillStyle to the pattern object
    // exactly once (the batch loop does its own string assign first).
    const patternAssignments = fillStyleAssignments.filter(v => typeof v !== 'string')
    expect(patternAssignments.length).toBe(1)
  })

  it('falls back to a flat tint when the environment has no createPattern', () => {
    const base = buildSliceBuffers(compactedTrack())
    const {ctx, fills, fillStyleAssignments} = makeStripeCtx({omitCreatePattern: true})
    drawFrame({
      ctx,
      slices: base,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 400,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
    })
    expect(fills.length).toBe(2)
    // Both assignments are strings (no pattern available); the second
    // is the documented fallback tint.
    for (const v of fillStyleAssignments) expect(typeof v).toBe('string')
    expect(fills[1].fillStyle).toBe(__test__.STRIPE_FALLBACK_FILL)
  })

  it('falls back to a flat tint when createPattern returns null (jsdom shape)', () => {
    const base = buildSliceBuffers(compactedTrack())
    const {ctx, fills} = makeStripeCtx({nullPattern: true})
    drawFrame({
      ctx,
      slices: base,
      marks: EMPTY_MARK_BUFFERS,
      widthCss: 400,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
    })
    expect(fills.length).toBe(2)
    expect(fills[1].fillStyle).toBe(__test__.STRIPE_FALLBACK_FILL)
  })
})

describe('drawHighlightFrame', () => {
  // Minimal ctx that records clearRect + fillRect geometry. The overlay
  // path never touches globalAlpha or font state, so we can stay lean.
  interface FillRectCall {
    x: number
    y: number
    w: number
    h: number
    fillStyle: string
  }
  function makeOverlayCtx(): {
    ctx: CanvasRenderingContext2D
    fills: FillRectCall[]
    fillTextCalls: Array<{text: string; x: number; y: number}>
    clears: Array<{x: number; y: number; w: number; h: number}>
  } {
    const fills: FillRectCall[] = []
    const fillTextCalls: Array<{text: string; x: number; y: number}> = []
    const clears: Array<{x: number; y: number; w: number; h: number}> = []
    let fillStyle = ''
    const ctx = {
      get fillStyle() {
        return fillStyle
      },
      set fillStyle(v: string) {
        fillStyle = v
      },
      set font(_v: string) {},
      set textBaseline(_v: CanvasTextBaseline) {},
      clearRect: (x: number, y: number, w: number, h: number): void => {
        clears.push({x, y, w, h})
      },
      fillRect: (x: number, y: number, w: number, h: number): void => {
        fills.push({x, y, w, h, fillStyle})
      },
      fillText: (text: string, x: number, y: number): void => {
        fillTextCalls.push({text, x, y})
      },
      measureText: (s: string) => ({width: s.length * 7}) as TextMetrics,
    } as unknown as CanvasRenderingContext2D
    return {ctx, fills, fillTextCalls, clears}
  }

  it('clears the target canvas on every call', () => {
    const base = buildSliceBuffers(track([m('a', 0, 100, [], '#ff0000')]))
    const {ctx, clears} = makeOverlayCtx()
    drawHighlightFrame({
      ctx,
      slices: base,
      widthCss: 200,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      highlight: {startMs: 0, endMs: 100, minDepth: 0},
    })
    expect(clears.length).toBe(1)
    expect(clears[0]).toEqual({x: 0, y: 0, w: 200, h: 20})
  })

  it('paints only slices fully inside the highlight span at depth >= minDepth', () => {
    // Tree: parent p [0,100], children c1 [10,30], c2 [40,90],
    // grandchild g [50,80]. Highlight c2 → only c2 + g should paint.
    const g = m('g', 50, 80)
    const c1 = m('c1', 10, 30)
    const c2 = m('c2', 40, 90, [g])
    const p = m('p', 0, 100, [c1, c2])
    const base = buildSliceBuffers(track([p]))

    const {ctx, fills} = makeOverlayCtx()
    drawHighlightFrame({
      ctx,
      slices: base,
      widthCss: 400,
      heightCss: 80,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      highlight: {startMs: 40, endMs: 90, minDepth: 1},
    })

    expect(fills.length).toBe(2)
    const xs = fills.map(f => f.x).sort((a, b) => a - b)
    expect(xs).toEqual([80, 100])
  })

  it('respects F32 snapping so the anchor and its descendants are included', () => {
    // Same setup as the old "F32 snapping" regression test, but now
    // scoped to drawHighlightFrame.
    const anchorEnd = 0.3
    expect(Math.fround(anchorEnd)).toBeGreaterThan(anchorEnd)
    const child = m('child', 0.1, 0.2)
    const anchor = m('anchor', 0, anchorEnd, [child])
    const buffers = buildSliceBuffers(track([anchor]))

    const {ctx, fills} = makeOverlayCtx()
    drawHighlightFrame({
      ctx,
      slices: buffers,
      widthCss: 400,
      heightCss: 40,
      rowHeight: 20,
      pxPerMs: 1000,
      visibleStartMs: 0,
      visibleEndMs: 1,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      highlight: {
        startMs: anchor.start,
        endMs: anchor.end,
        minDepth: 0,
      },
    })
    expect(fills.length).toBe(2)
  })

  it('paints the union of multiple highlight regions when an array is passed', () => {
    // Two disjoint sibling subtrees:
    //   s1 [10,30] with child s1c [15,25]
    //   s2 [60,90] with child s2c [70,80]
    // Highlighting both at once (selection + hover live together
    // when the user clicks one slice and hovers another) should
    // paint every slice in either subtree exactly once.
    const s1c = m('s1c', 15, 25)
    const s2c = m('s2c', 70, 80)
    const s1 = m('s1', 10, 30, [s1c])
    const s2 = m('s2', 60, 90, [s2c])
    const p = m('p', 0, 100, [s1, s2])
    const base = buildSliceBuffers(track([p]))

    const {ctx, fills} = makeOverlayCtx()
    drawHighlightFrame({
      ctx,
      slices: base,
      widthCss: 400,
      heightCss: 80,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      highlight: [
        {startMs: 10, endMs: 30, minDepth: 1},
        {startMs: 60, endMs: 90, minDepth: 1},
      ],
    })

    // 4 slices: s1, s1c, s2, s2c. Parent `p` is excluded by minDepth.
    expect(fills.length).toBe(4)
    const xs = fills.map(f => f.x).sort((a, b) => a - b)
    expect(xs).toEqual([20, 30, 120, 140])
  })

  it('clears and returns when given an empty highlights array', () => {
    const base = buildSliceBuffers(track([m('a', 0, 100, [], '#ff0000')]))
    const {ctx, fills, clears} = makeOverlayCtx()
    drawHighlightFrame({
      ctx,
      slices: base,
      widthCss: 200,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      highlight: [],
    })
    expect(clears.length).toBe(1)
    expect(fills.length).toBe(0)
  })

  it('emits no fillRects when the highlight span lies outside the viewport', () => {
    const base = buildSliceBuffers(track([m('a', 0, 100, [], '#ff0000')]))
    const {ctx, fills, clears} = makeOverlayCtx()
    drawHighlightFrame({
      ctx,
      slices: base,
      widthCss: 200,
      heightCss: 20,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 500,
      visibleEndMs: 600,
      canvasStartMs: 500,
      maxDepthExclusive: Infinity,
      highlight: {startMs: 0, endMs: 100, minDepth: 0},
    })
    // We still clear (so a stale previous highlight never lingers), but
    // no rects land in the visible region.
    expect(clears.length).toBe(1)
    expect(fills.length).toBe(0)
  })

  it('emits labels for wide singletons inside the highlight tree', () => {
    const anchor = m('myAnchor', 0, 100)
    const base = buildSliceBuffers(track([anchor]))
    const {ctx, fillTextCalls} = makeOverlayCtx()
    drawHighlightFrame({
      ctx,
      slices: base,
      widthCss: 400,
      heightCss: 20,
      rowHeight: 22,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      baseMeasures: base.measures,
      highlight: {startMs: 0, endMs: 100, minDepth: 0},
    })
    expect(fillTextCalls.length).toBe(1)
    expect(fillTextCalls[0].text).toBe('myAnchor')
  })

  it('matches the base renderer\'s batch-insertion order so same-depth overlaps stack identically', () => {
    // Regression for the `performWorkUntilDeadline` hover bug: the
    // overlay used to emit rects either in color-batched order (pre-
    // change) or in strict iteration order (the first attempted fix).
    // Both produced a z-order that disagreed with the base — letting
    // narrow gray density buckets bleed through the middle of a wide
    // mint userScript bucket that sits underneath them in the base
    // canvas.
    //
    // The correct contract is: the overlay's emit order must equal the
    // base's emit order. The base batches by color and emits batches
    // in first-seen-color-in-visible-window order. So the overlay has
    // to seed its batch map from the same visible window (not just the
    // hovered tree) so the color insertion order matches, then only
    // actually push rects for slices in the tree.
    //
    // Setup: depth-0 row with four "slices":
    //   A @ [0, 40]   color #ff0000 (red)    — outside tree (anchor context)
    //   H @ [50, 200] color #00ff00 (green)  — the hovered anchor, mint stand-in
    //   X @ [60, 80]  color #0000ff (blue)   — inside tree, a different color
    //   Y @ [100, 120] color #ff0000 (red)   — inside tree, same color as A
    //
    // The visible window includes A (outside tree). A's red color gets
    // inserted into the batch map FIRST even though A itself is not
    // emitted. That means red batches render before green which
    // renders before blue. Inside the tree only H, X, Y exist —
    // emission order: red (Y), green (H), blue (X). So Y (red) paints
    // first, then H (green) second covering Y's area, then X (blue)
    // last on top.
    const rawMeasures: Measure[] = [
      m('A', 0, 40, [], '#ff0000'),
      m('H', 50, 200, [m('X', 60, 80, [], '#0000ff'), m('Y', 100, 120, [], '#ff0000')], '#00ff00'),
    ]
    const base = buildSliceBuffers(track(rawMeasures))

    const {ctx, fills} = makeOverlayCtx()
    drawHighlightFrame({
      ctx,
      slices: base,
      widthCss: 400,
      heightCss: 60,
      rowHeight: 20,
      pxPerMs: 1,
      visibleStartMs: 0,
      visibleEndMs: 200,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      highlight: {startMs: 50, endMs: 200, minDepth: 0},
    })

    // A is outside the tree; H, X, Y are inside. Three rects emitted.
    expect(fills.length).toBe(3)
    // Batch order seeded by the visible window: red (from A) → green
    // (from H) → blue (from X). Emission follows batch order.
    // In that order: Y (red), H (green), X (blue).
    expect(fills[0]).toMatchObject({fillStyle: 'rgb(255,0,0)', x: 100}) // Y
    expect(fills[1]).toMatchObject({fillStyle: 'rgb(0,255,0)', x: 50}) // H
    expect(fills[2]).toMatchObject({fillStyle: 'rgb(0,0,255)', x: 60}) // X
  })

  it('skips depths below minDepth', () => {
    // Parent at depth 0 is excluded because the highlight anchor is its
    // child at depth 1. The child + grandchild are still fully inside
    // the highlight span and must paint.
    const g = m('g', 50, 80)
    const c2 = m('c2', 40, 90, [g])
    const p = m('p', 0, 100, [c2])
    const base = buildSliceBuffers(track([p]))

    const {ctx, fills} = makeOverlayCtx()
    drawHighlightFrame({
      ctx,
      slices: base,
      widthCss: 400,
      heightCss: 80,
      rowHeight: 20,
      pxPerMs: 2,
      visibleStartMs: 0,
      visibleEndMs: 100,
      canvasStartMs: 0,
      maxDepthExclusive: Infinity,
      highlight: {startMs: 40, endMs: 90, minDepth: 1},
    })
    expect(fills.length).toBe(2)
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
