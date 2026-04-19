import {
  DEFAULT_MARK_COLOR,
  DEFAULT_MEASURE_COLOR,
  packColor,
  unpackColorToCss,
} from '../core/render/packColor'

describe('packColor', () => {
  it('returns the fallback for undefined input', () => {
    expect(packColor(undefined, DEFAULT_MEASURE_COLOR)).toBe(DEFAULT_MEASURE_COLOR)
  })

  it('parses #rrggbb into 0xRRGGBBAA with full alpha', () => {
    const packed = packColor('#4a5568', 0)
    expect(packed >>> 0).toBe(0x4a5568ff)
  })

  it('parses short #rgb as expanded double-digit hex', () => {
    const packed = packColor('#abc', 0)
    expect(packed >>> 0).toBe(0xaabbccff)
  })

  it('parses rgba(r,g,b,a) with 0..1 alpha', () => {
    const packed = packColor('rgba(255, 128, 0, 0.5)', 0)
    const a = packed & 0xff
    expect(a).toBeGreaterThanOrEqual(127)
    expect(a).toBeLessThanOrEqual(128)
    expect((packed >>> 24) & 0xff).toBe(255)
    expect((packed >>> 16) & 0xff).toBe(128)
    expect((packed >>> 8) & 0xff).toBe(0)
  })

  it('falls back for unknown shapes like named colors', () => {
    expect(packColor('tomato', DEFAULT_MARK_COLOR)).toBe(DEFAULT_MARK_COLOR)
  })

  it('unpacks back to a css rgb() string for opaque colors', () => {
    expect(unpackColorToCss(DEFAULT_MEASURE_COLOR)).toBe('rgb(74,85,104)')
  })

  it('unpacks back to rgba() when alpha < 255', () => {
    const css = unpackColorToCss(packColor('rgba(10,20,30,0.25)', 0))
    expect(css.startsWith('rgba(10,20,30,')).toBe(true)
  })
})
