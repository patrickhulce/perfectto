import type {TimelineContainer} from '../../core'

export const ROW_HEIGHT = 22

export function containerDepth(container: TimelineContainer): number {
  let max = 0
  for (const measure of container.measures) {
    const childDepth = 1 + containerDepth(measure)
    if (childDepth > max) max = childDepth
  }
  if (container.marks.length > 0 && max === 0) max = 1
  return max
}
