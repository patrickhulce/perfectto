import { formatBytes } from '../utils/formatBytes.js'

describe('formatBytes', () => {
  it('formats bytes under 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('formats kilobytes with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB')
  })

  it('formats megabytes with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB')
  })
})
