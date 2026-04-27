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
import type {AppliedPersona, CategoryDef, OverviewBand, Persona} from './types'

/**
 * Apply a persona to a parsed trace. Returns a UI-facing view
 * ({@link AppliedPersona}) and, as a side effect, repaints every
 * track's color buffers in place using the persona's color rules. The
 * raw trace structure (measures, starts, ends, systems, tracks) is
 * never mutated.
 *
 * Re-calling `applyPersona` with a different persona is safe and is the
 * intended way to switch personas at runtime — the color arrays are
 * overwritten with new values, no structural work happens.
 *
 * The raw persona (no color rules, no track rules, no bands) is a
 * fast path: we still recompute colors from Measure.color defaults so
 * that switching away from Web back to Raw restores the
 * original palette.
 */
export function applyPersona(trace: ParsedTrace, persona: Persona): AppliedPersona {
  const compiledColorRules = persona.colorRules.map(compileColorRule)
  const compiledTrackRules = persona.trackRules.map(compileTrackRule)
  const compiledSystemRules = (persona.systemRules ?? []).map(compileSystemRule)
  const palette = packCategoryPalette(persona.categories)

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
    // persona is exactly "what the parser produced".
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

  const defaultTracksExpanded = persona.defaultTracksExpanded
  const defaultSystemsExpanded = persona.defaultSystemsExpanded

  // Dynamic featuring: the persona may name specific track ids whose
  // expand-state can't be derived from a static {@link TrackRule}
  // (e.g. "the dominant Python thread by event count"). Each id in
  // the set forces the track expanded and its containing system
  // expanded, regardless of the static rule resolution below. Built
  // once up-front so we can do an O(1) lookup per track.
  const featuredTrackIds = new Set<string>(persona.featureTracks?.(trace) ?? [])
  // Parent system id of each featured track id. Captured during the
  // track loop so we can flip the system expand-state after rules
  // have been resolved.
  const featuredSystemIds = new Set<string>()

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
        // Persona-wide baseline: unmatched tracks collapse by default.
        defaultTrackExpanded[track.id] = false
      }
      // featureTracks() override: a dynamically-picked track always
      // wins over both the static rule and the persona baseline.
      // Recorded last so this branch is the final write.
      if (featuredTrackIds.has(track.id)) {
        defaultTrackExpanded[track.id] = true
        featuredSystemIds.add(system.id)
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
    // featureTracks() override: any system that contains a featured
    // track must be expanded so the user can actually see it. Wins
    // over both SystemRule and the persona baseline.
    if (featuredSystemIds.has(system.id)) {
      systemExpanded = true
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
  //
  // Bands are derived from the persona's root categories (those without a
  // `parentId`) in the order given by `overviewOrder`. Subcategories are
  // rolled up into their root ancestor's band by walking the `parentId`
  // chain once, so `bandForCategory` always returns a root id — or is
  // absent if the root isn't listed in `overviewOrder` (e.g. `idle`,
  // `other`, which explicitly contribute no overview stripe).

  const categoryById = new Map<string, CategoryDef>()
  for (const c of persona.categories) categoryById.set(c.id, c)

  const orderedBands = new Set(persona.overviewOrder)

  // Nearest-ancestor band resolver: walks the parentId chain and
  // returns the first category (self or ancestor) that's listed in
  // `overviewOrder`. This way a subcategory that's explicitly
  // promoted into `overviewOrder` keeps its own band instead of
  // silently rolling up to a coarser root. Cycle-guarded.
  const bandForId = (id: string): string | undefined => {
    let cur = categoryById.get(id)
    if (!cur) return undefined
    const seen = new Set<string>()
    while (cur) {
      if (orderedBands.has(cur.id)) return cur.id
      if (cur.parentId === undefined) return undefined
      if (seen.has(cur.id)) return undefined
      seen.add(cur.id)
      cur = categoryById.get(cur.parentId)
    }
    return undefined
  }

  const bandForCategory: Record<string, string> = {}
  for (const cat of persona.categories) {
    const band = bandForId(cat.id)
    if (band !== undefined) bandForCategory[cat.id] = band
  }

  const bands: OverviewBand[] = []
  for (const rootId of persona.overviewOrder) {
    const cat = categoryById.get(rootId)
    if (!cat) continue
    bands.push({id: cat.id, label: cat.label, color: cat.color})
  }

  // Overview scope: derive the subset of visible systems whose tracks
  // the overview chart should aggregate over. A track "opts in" by
  // ending up with `defaultTrackExpanded[id] === true`, which in
  // practice means a TrackRule (or the persona's baseline) explicitly
  // flagged it as important enough to start open.
  //
  // We deliberately don't just filter by "whatever the UI currently has
  // expanded" — that would make the overview jitter as the user folds
  // tracks open and closed. The persona-declared default is the stable
  // signal the user picked when choosing this persona.
  //
  // If nothing opts in (raw persona, generic fallbacks), fall back to
  // the full visible list so the overview isn't blank — matches the
  // pre-scoping behaviour for personas that don't single any track out.
  const scopedSystems: System[] = []
  let anyExpanded = false
  for (const sys of derivedSystems) {
    const kept = sys.tracks.filter(t => defaultTrackExpanded[t.id] === true)
    if (kept.length > 0) {
      anyExpanded = true
      scopedSystems.push({...sys, tracks: kept})
    }
  }
  const overviewSystems: readonly System[] = anyExpanded ? scopedSystems : derivedSystems

  return {
    persona,
    systems: derivedSystems,
    overviewSystems,
    hiddenTracksBySystem,
    hiddenSystems,
    defaultSystemExpanded,
    defaultTrackExpanded,
    trackLabels,
    resolveCategoryId,
    bandForCategory,
    bands,
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
 * expand-state keys survive persona switches; only `name` changes.
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
