/**
 * Smallest index `i` in `arr` such that `item.start >= target`, or `arr.length`
 * if none. `arr` must be sorted ascending by `start`.
 */
export function lowerBoundByStart<T extends {start: number}>(
  arr: readonly T[],
  target: number,
): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid].start < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Same as {@link lowerBoundByStart} but for items keyed on `.time`. */
export function lowerBoundByTime<T extends {time: number}>(
  arr: readonly T[],
  target: number,
): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid].time < target) lo = mid + 1
    else hi = mid
  }
  return lo
}
