import {DEFAULT_MEASURE_COLOR, packColor} from '../render/packColor'
import type {Measure, ParsedTrace, System, Track} from '../types'
import {
  compileColorRule,
  compileSystemRule,
  compileTrackRule,
  type CompiledSystemRule,
  type CompiledTrackRule,
} from './ruleMatchers'
import {packCategoryPalette, rebuildTrackColors} from './rebuildTrackColors'
import type {AppliedProfile, Profile} from './types'

/**
 * Apply a profile to a parsed trace. Returns a UI-facing view
 * ({@link AppliedProfile}) and, as a side effect, repaints every
 * track's color buffers in place using the profile's color rules. The
 * raw trace structure (measures, starts, ends, systems, tracks) is
 * never mutated.
 *
 * Re-calling `applyProfile` with a different profile is safe and is the
 * intended way to switch profiles at runtime — the color arrays are
 * overwritten with new values, no structural work happens.
 *
 * The raw profile (no color rules, no track rules, no bands) is a
 * fast path: we still recompute colors from Measure.color defaults so
 * that switching away from Web Developer back to Raw restores the
 * original palette.
 */
export function applyProfile(trace: ParsedTrace, profile: Profile): AppliedProfile {
  const compiledColorRules = profile.colorRules.map(compileColorRule)
  const compiledTrackRules = profile.trackRules.map(compileTrackRule)
  const compiledSystemRules = (profile.systemRules ?? []).map(compileSystemRule)
  const palette = packCategoryPalette(profile.categories)

  // Build a reusable measure-resolver that only depends on the compiled
  // rules and the palette. Looked up per-slice during the repaint.
  const resolveCategoryId = (m: Measure, track: Track, system: System): string | undefined => {
    if (compiledColorRules.length === 0) return undefined
    for (const rule of compiledColorRules) {
      if (!rule.measureName(m.name)) continue
      if (!rule.traceCategory(m.category)) continue
      if (!rule.trackName(track.name)) continue
      if (!rule.systemName(system.name)) continue
      return rule.categoryId
    }
    return undefined
  }

  const resolveColor = (m: Measure, track: Track, system: System): number => {
    const catId = resolveCategoryId(m, track, system)
    if (catId !== undefined) {
      const packed = palette.get(catId)
      if (packed !== undefined) return packed
    }
    // No rule matched or the category id isn't defined in the palette:
    // fall back to the measure's own color, or the default gray. Matches
    // what sliceBuffers.buildSliceBuffers does at parse time so Raw
    // profile is exactly "what the parser produced".
    return packMeasureDefaultColor(m)
  }

  // Side effect: repaint every track.
  for (const system of trace.timeline.systems) {
    for (const track of system.tracks) {
      rebuildTrackColors(track, system, resolveColor)
    }
  }

  // ---------------------------------------------------------------------
  // Per-system track pass: relabel, hide, default-expand, sort tracks.
  // Also collects per-system info (order, hidden, label) for the
  // subsequent system-level pass.
  // ---------------------------------------------------------------------

  const hiddenTracksBySystem: Record<string, Track[]> = {}
  const defaultTrackExpanded: Record<string, boolean> = {}
  const defaultSystemExpanded: Record<string, boolean> = {}
  const trackLabels: Record<string, string> = {}
  const systemLabels: Record<string, string> = {}

  const defaultTracksExpanded = profile.defaultTracksExpanded
  const defaultSystemsExpanded = profile.defaultSystemsExpanded

  interface SystemCandidate {
    system: System
    derivedTracks: Track[]
    priority: number
    pinToTop: boolean
    hidden: boolean
    order: number
  }
  const candidates: SystemCandidate[] = []

  for (let si = 0; si < trace.timeline.systems.length; si++) {
    const system = trace.timeline.systems[si]

    const visible: Array<{track: Track; priority: number; pinToTop: boolean; order: number}> = []
    const hidden: Track[] = []
    let systemExpandedFromTrackRule: boolean | undefined

    for (let i = 0; i < system.tracks.length; i++) {
      const track = system.tracks[i]
      const effects = matchTrackEffects(track, system, compiledTrackRules)

      if (effects.relabel !== undefined) {
        trackLabels[track.id] = effects.relabel
      }
      if (effects.defaultExpanded !== undefined) {
        defaultTrackExpanded[track.id] = effects.defaultExpanded
      } else if (defaultTracksExpanded === false) {
        // Profile-wide baseline: unmatched tracks collapse by default.
        defaultTrackExpanded[track.id] = false
      }
      if (effects.defaultSystemExpanded !== undefined) {
        // A TrackRule forcing its parent system open/closed (e.g.
        // CrRendererMain → expand the Renderer system) is more specific
        // than a SystemRule; we prefer it below.
        systemExpandedFromTrackRule = effects.defaultSystemExpanded
      }

      if (effects.hidden === true) {
        hidden.push(track)
        continue
      }

      visible.push({
        track,
        priority: effects.sortPriority ?? Number.POSITIVE_INFINITY,
        pinToTop: effects.pinToTop === true,
        order: i,
      })
    }

    // Sort tracks within the system: pinned first, then sortPriority
    // ascending, stable on original index for the tail.
    visible.sort((a, b) => {
      if (a.pinToTop !== b.pinToTop) return a.pinToTop ? -1 : 1
      if (a.priority !== b.priority) return a.priority - b.priority
      return a.order - b.order
    })

    const derivedTracks = visible.map(v => applyRelabel(v.track, trackLabels))
    if (hidden.length > 0) {
      hiddenTracksBySystem[system.id] = hidden.map(t => applyRelabel(t, trackLabels))
    }

    // System-level effects: SystemRule matches first, then a TrackRule
    // default-system override stomps it (more specific wins).
    const sysEffects = matchSystemEffects(system, compiledSystemRules)
    if (sysEffects.relabel !== undefined) {
      systemLabels[system.id] = sysEffects.relabel
    }
    let systemExpanded: boolean | undefined = sysEffects.defaultExpanded
    if (systemExpandedFromTrackRule !== undefined) {
      systemExpanded = systemExpandedFromTrackRule
    }
    if (systemExpanded === undefined && defaultSystemsExpanded === false) {
      systemExpanded = false
    }
    if (systemExpanded !== undefined) {
      defaultSystemExpanded[system.id] = systemExpanded
    }

    candidates.push({
      system,
      derivedTracks,
      priority: sysEffects.sortPriority ?? Number.POSITIVE_INFINITY,
      pinToTop: sysEffects.pinToTop === true,
      hidden: sysEffects.hidden === true,
      order: si,
    })
  }

  // Filter + sort systems themselves. Sort order mirrors the
  // intra-system track sort: pinned first, then priority asc, stable on
  // original discovery order.
  const visibleSystems = candidates.filter(c => !c.hidden)
  visibleSystems.sort((a, b) => {
    if (a.pinToTop !== b.pinToTop) return a.pinToTop ? -1 : 1
    if (a.priority !== b.priority) return a.priority - b.priority
    return a.order - b.order
  })

  const derivedSystems: System[] = visibleSystems.map(c =>
    applySystemRelabel(
      {id: c.system.id, name: c.system.name, tracks: c.derivedTracks},
      systemLabels,
    ),
  )
  const hiddenSystems: System[] = candidates
    .filter(c => c.hidden)
    .map(c =>
      applySystemRelabel(
        {id: c.system.id, name: c.system.name, tracks: c.derivedTracks},
        systemLabels,
      ),
    )

  // ---------------------------------------------------------------------
  // Overview band plumbing.
  // ---------------------------------------------------------------------

  const bandForCategory: Record<string, string> = {}
  for (const band of profile.overviewBands) {
    for (const catId of band.categoryIds) {
      bandForCategory[catId] = band.id
    }
  }

  return {
    profile,
    systems: derivedSystems,
    hiddenTracksBySystem,
    hiddenSystems,
    defaultSystemExpanded,
    defaultTrackExpanded,
    trackLabels,
    resolveCategoryId,
    bandForCategory,
    bands: profile.overviewBands,
  }
}

function matchSystemEffects(
  system: System,
  rules: CompiledSystemRule[],
): CompiledSystemRule['effects'] {
  const out: CompiledSystemRule['effects'] = {}
  for (const rule of rules) {
    if (!rule.name(system.name)) continue
    const e = rule.effects
    if (e.sortPriority !== undefined) out.sortPriority = e.sortPriority
    if (e.pinToTop !== undefined) out.pinToTop = e.pinToTop
    if (e.defaultExpanded !== undefined) out.defaultExpanded = e.defaultExpanded
    if (e.hidden !== undefined) out.hidden = e.hidden
    if (e.relabel !== undefined) out.relabel = e.relabel
  }
  return out
}

function applySystemRelabel(system: System, labels: Record<string, string>): System {
  const relabel = labels[system.id]
  if (relabel === undefined || relabel === system.name) return system
  return {
    ...system,
    name: relabel,
  }
}

function matchTrackEffects(
  track: Track,
  system: System,
  rules: CompiledTrackRule[],
): CompiledTrackRule['effects'] {
  const out: CompiledTrackRule['effects'] = {}
  for (const rule of rules) {
    if (!rule.systemName(system.name)) continue
    if (!rule.trackName(track.name)) continue
    if (!rule.trackCategory(track.category)) continue
    const e = rule.effects
    if (e.sortPriority !== undefined) out.sortPriority = e.sortPriority
    if (e.pinToTop !== undefined) out.pinToTop = e.pinToTop
    if (e.defaultExpanded !== undefined) out.defaultExpanded = e.defaultExpanded
    if (e.defaultSystemExpanded !== undefined) {
      out.defaultSystemExpanded = e.defaultSystemExpanded
    }
    if (e.hidden !== undefined) out.hidden = e.hidden
    if (e.relabel !== undefined) out.relabel = e.relabel
  }
  return out
}

/**
 * Produce a lightweight shallow-clone of the track with a relabeled
 * display name. We intentionally keep `id` stable so React keys and
 * expand-state keys survive profile switches; only `name` changes.
 * `buffers`, `markBuffers`, `mipmap`, `marks`, `measures` pass through
 * unchanged so no typed-array churn.
 */
function applyRelabel(track: Track, labels: Record<string, string>): Track {
  const relabel = labels[track.id]
  if (relabel === undefined || relabel === track.name) return track
  return {
    ...track,
    name: relabel,
  }
}

/**
 * Mirror of buildSliceBuffers' default-color logic. Kept inline here
 * rather than exported from sliceBuffers to avoid re-parsing CSS on
 * the hot path — 99% of the time `m.color` is undefined and we can
 * short-circuit to the packed default.
 */
function packMeasureDefaultColor(m: Measure): number {
  if (!m.color) return DEFAULT_MEASURE_COLOR
  // Rare path: a parser actually set a measure color. Re-pack it the
  // same way buildSliceBuffers did. packColor caches by string so
  // repeated calls across a trace are effectively free.
  return packColor(m.color, DEFAULT_MEASURE_COLOR)
}
