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
