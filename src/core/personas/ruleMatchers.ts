import type {ColorRule, SystemRule, TrackRule} from './types'

/**
 * Compile a string-or-regex into a fast predicate. Strings use exact
 * equality; regexes use `.test()`. Undefined patterns compile to a
 * predicate that matches anything (so the caller can AND an array of
 * optional conditions without branching on each one).
 */
type StringMatcher = (value: string | undefined) => boolean

function compileMatcher(pattern: string | RegExp | undefined): StringMatcher {
  if (pattern === undefined) return () => true
  if (typeof pattern === 'string') {
    return value => value === pattern
  }
  return value => (value === undefined ? false : pattern.test(value))
}

export interface CompiledColorRule {
  measureName: StringMatcher
  traceCategory: StringMatcher
  trackName: StringMatcher
  systemName: StringMatcher
  categoryId: string
}

export function compileColorRule(rule: ColorRule): CompiledColorRule {
  return {
    measureName: compileMatcher(rule.measureName),
    traceCategory: compileMatcher(rule.traceCategory),
    trackName: compileMatcher(rule.trackName),
    systemName: compileMatcher(rule.systemName),
    categoryId: rule.categoryId,
  }
}

export interface CompiledTrackRule {
  systemName: StringMatcher
  trackName: StringMatcher
  trackCategory: StringMatcher
  effects: {
    sortPriority?: number
    pinToTop?: boolean
    defaultExpanded?: boolean
    defaultSystemExpanded?: boolean
    hidden?: boolean
    relabel?: string
  }
}

export function compileTrackRule(rule: TrackRule): CompiledTrackRule {
  return {
    systemName: compileMatcher(rule.systemName),
    trackName: compileMatcher(rule.trackName),
    trackCategory: compileMatcher(rule.trackCategory),
    effects: {
      sortPriority: rule.sortPriority,
      pinToTop: rule.pinToTop,
      defaultExpanded: rule.defaultExpanded,
      defaultSystemExpanded: rule.defaultSystemExpanded,
      hidden: rule.hidden,
      relabel: rule.relabel,
    },
  }
}

export interface CompiledSystemRule {
  name: StringMatcher
  effects: {
    sortPriority?: number
    pinToTop?: boolean
    defaultExpanded?: boolean
    hidden?: boolean
    relabel?: string
  }
}

export function compileSystemRule(rule: SystemRule): CompiledSystemRule {
  return {
    name: compileMatcher(rule.name),
    effects: {
      sortPriority: rule.sortPriority,
      pinToTop: rule.pinToTop,
      defaultExpanded: rule.defaultExpanded,
      hidden: rule.hidden,
      relabel: rule.relabel,
    },
  }
}
