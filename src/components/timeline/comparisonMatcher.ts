import type {Measure} from '../../core'
import type {Matcher} from '../../core/matcher'
import type {SliceRef} from './selectionStore'

export interface ComparisonMatcher {
  matcher: Matcher
  resolveForeignMeasure(slice: SliceRef): Measure | null
}
