/**
 * Pack a CSS color string into a single `0xRRGGBBAA` Uint32 so the canvas
 * renderer can group draws by color without paying a per-frame string parse.
 *
 * Supports the two shapes the parsers emit today:
 *   - `#rrggbb` or `#rgb` hex literals (most measures/marks use these)
 *   - `rgba(r, g, b, a)` / `rgb(r, g, b)` (rare, allowed for forwards-compat)
 *
 * Anything else falls back to `fallback`. Results are cached so packing the
 * same color literal across thousands of measures is effectively free.
 */

const cache = new Map<string, number>()

export function packColor(input: string | undefined, fallback: number): number {
  if (!input) return fallback
  const cached = cache.get(input)
  if (cached !== undefined) return cached
  const packed = parse(input)
  const resolved = packed ?? fallback
  cache.set(input, resolved)
  return resolved
}

function parse(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  if (trimmed.charCodeAt(0) === 35 /* # */) return parseHex(trimmed)
  if (trimmed.startsWith('rgb')) return parseRgb(trimmed)
  return null
}

function parseHex(hex: string): number | null {
  const body = hex.slice(1)
  if (body.length === 3) {
    const r = hexDigit(body.charCodeAt(0))
    const g = hexDigit(body.charCodeAt(1))
    const b = hexDigit(body.charCodeAt(2))
    if (r < 0 || g < 0 || b < 0) return null
    return pack((r << 4) | r, (g << 4) | g, (b << 4) | b, 0xff)
  }
  if (body.length === 4) {
    const r = hexDigit(body.charCodeAt(0))
    const g = hexDigit(body.charCodeAt(1))
    const b = hexDigit(body.charCodeAt(2))
    const a = hexDigit(body.charCodeAt(3))
    if (r < 0 || g < 0 || b < 0 || a < 0) return null
    return pack((r << 4) | r, (g << 4) | g, (b << 4) | b, (a << 4) | a)
  }
  if (body.length === 6) {
    const n = parseInt(body, 16)
    if (!Number.isFinite(n)) return null
    return pack((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 0xff)
  }
  if (body.length === 8) {
    const n = parseInt(body, 16)
    if (!Number.isFinite(n)) return null
    // #RRGGBBAA in CSS is already RRGGBBAA — no reshuffling needed.
    return n >>> 0
  }
  return null
}

function parseRgb(input: string): number | null {
  const open = input.indexOf('(')
  const close = input.indexOf(')', open + 1)
  if (open < 0 || close < 0) return null
  const parts = input.slice(open + 1, close).split(',')
  if (parts.length < 3) return null
  const r = clampByte(parseFloat(parts[0]))
  const g = clampByte(parseFloat(parts[1]))
  const b = clampByte(parseFloat(parts[2]))
  if (r === null || g === null || b === null) return null
  let a = 0xff
  if (parts.length >= 4) {
    const af = parseFloat(parts[3])
    if (!Number.isFinite(af)) return null
    a = Math.max(0, Math.min(255, Math.round(af * 255)))
  }
  return pack(r, g, b, a)
}

function pack(r: number, g: number, b: number, a: number): number {
  return ((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff)
}

function hexDigit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48 // 0-9
  if (code >= 97 && code <= 102) return code - 87 // a-f
  if (code >= 65 && code <= 70) return code - 55 // A-F
  return -1
}

function clampByte(n: number): number | null {
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(255, Math.round(n)))
}

/**
 * Convert a packed `0xRRGGBBAA` Uint32 into a CSS-ready `rgba()` string. Used
 * by the canvas renderer once per color batch per frame, so the string alloc
 * cost is bounded by the number of distinct colors, not by slice count.
 */
export function unpackColorToCss(packed: number): string {
  const r = (packed >>> 24) & 0xff
  const g = (packed >>> 16) & 0xff
  const b = (packed >>> 8) & 0xff
  const a = packed & 0xff
  if (a === 0xff) return `rgb(${r},${g},${b})`
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`
}

export const DEFAULT_MEASURE_COLOR = pack(0x4a, 0x55, 0x68, 0xff)
export const DEFAULT_MARK_COLOR = pack(0xed, 0x89, 0x36, 0xff)
