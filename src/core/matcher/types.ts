import type {Measure} from '../types'

export type MatchHeuristic = 'exactTree' | 'shapeWithDuration' | 'nameOnly'
export type VicinityRule = 'absolute' | 'globalRelative' | 'rootRelative'

export interface MatchCandidate {
  measure: Measure
  trackId: string
  depth: number
  heuristic: MatchHeuristic
  vicinity: VicinityRule
}

export interface Matcher {
  findMatch(measure: Measure, fromTrackId: string): MatchCandidate | null
}
