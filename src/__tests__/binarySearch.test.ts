import {lowerBoundByStart, lowerBoundByTime} from '../components/timeline/binarySearch'

describe('lowerBoundByStart', () => {
  const items = [{start: 0}, {start: 1}, {start: 5}, {start: 5}, {start: 10}]

  it('returns 0 when target is below all elements', () => {
    expect(lowerBoundByStart(items, -5)).toBe(0)
  })

  it('returns length when target is above all elements', () => {
    expect(lowerBoundByStart(items, 100)).toBe(items.length)
  })

  it('returns the first index whose start >= target', () => {
    expect(lowerBoundByStart(items, 5)).toBe(2)
    expect(lowerBoundByStart(items, 4)).toBe(2)
    expect(lowerBoundByStart(items, 6)).toBe(4)
  })

  it('handles empty arrays', () => {
    expect(lowerBoundByStart([], 0)).toBe(0)
  })
})

describe('lowerBoundByTime', () => {
  it('finds the first mark at or after target', () => {
    const marks = [{time: 0}, {time: 3}, {time: 7}]
    expect(lowerBoundByTime(marks, 0)).toBe(0)
    expect(lowerBoundByTime(marks, 4)).toBe(2)
    expect(lowerBoundByTime(marks, 8)).toBe(3)
  })
})
