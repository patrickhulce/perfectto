import type {Measure, ParsedTrace, System, Track} from '../types'

/**
 * A persona is a pluggable interpretation of a trace. Given a parsed trace,
 * a persona tells the viewer how to colorize slices, which tracks matter
 * (and in what order), which should be hidden or expanded by default, and
 * which categories stack into the overview band chart.
 *
 * Personas never mutate the raw {@link ParsedTrace}. {@link applyPersona}
 * produces an {@link AppliedPersona} with derived views the UI consumes.
 */
export interface Persona {
  /** Stable machine id, e.g. `'web-dev'`, `'raw'`. */
  id: string
  /** Human-facing name for the persona picker. */
  name: string
  /** One-line description shown in the picker / tooltip. */
  description: string

  /**
   * Auto-detection score. Higher wins; 0 means "does not apply". Personas
   * should look at track/system names, metadata, and other stable
   * features of the trace. Must not mutate the trace.
   */
  match(trace: ParsedTrace): number

  /** Palette: every `categoryId` referenced by a `ColorRule` must be defined here. */
  categories: CategoryDef[]
  /** Ordered list of color rules. First match wins per measure. */
  colorRules: ColorRule[]
  /** Ordered list of track rules. All matching rules apply, last-write wins per field. */
  trackRules: TrackRule[]
  /**
   * Ordered list of system-level rules. All matching rules apply,
   * last-write wins per field. Lets a persona hide / reorder / default-
   * collapse entire processes (e.g. the kernel's pid-0 system).
   */
  systemRules?: SystemRule[]
  /** Stacked overview bands, ordered bottom-to-top in the rendered chart. */
  overviewBands: OverviewBand[]
  /**
   * Baseline expand-state for tracks that no {@link TrackRule} touches.
   * Undefined → UI default (expanded). A persona can flip this to
   * `false` to collapse everything except explicitly-opted-in tracks.
   */
  defaultTracksExpanded?: boolean
  /**
   * Baseline expand-state for systems that no {@link SystemRule} or
   * {@link TrackRule.defaultSystemExpanded} touches. Same semantics as
   * {@link Persona.defaultTracksExpanded}.
   */
  defaultSystemsExpanded?: boolean
}

/**
 * A named color bucket. Slices matching a {@link ColorRule} with a given
 * `categoryId` are all repainted to the corresponding {@link CategoryDef.color}.
 */
export interface CategoryDef {
  id: string
  label: string
  /** CSS color string (`#rrggbb`, `#rgb`, or `rgb()/rgba()`). */
  color: string
}

/**
 * A pattern that matches one or more measures. All present fields are
 * AND-ed. A rule with no fields matches every measure (useful as a catch-all).
 */
export interface ColorRule {
  measureName?: string | RegExp
  /** Matches `Measure.category` as emitted by the parser (raw trace `cat`). */
  traceCategory?: string | RegExp
  trackName?: string | RegExp
  systemName?: string | RegExp
  /** Id of the {@link CategoryDef} to paint the slice with. */
  categoryId: string
}

/**
 * A pattern that targets one or more tracks. Unlike {@link ColorRule}, the
 * effect fields combine across matching rules (last-write wins per field)
 * so a track can pick up its priority from one rule and its default
 * expanded state from another.
 */
export interface TrackRule {
  systemName?: string | RegExp
  trackName?: string | RegExp
  trackCategory?: string | RegExp

  /** Lower values sort earlier; unset tracks sort after all priority-having ones. */
  sortPriority?: number
  /** Force this track pinned to the top regardless of other sort. */
  pinToTop?: boolean
  /** Initial expanded state for the track; overrides the viewer default. */
  defaultExpanded?: boolean
  /** Initial expanded state for this track's containing system. */
  defaultSystemExpanded?: boolean
  /**
   * When true, the track is omitted from the default view. The user can
   * reveal hidden tracks via a per-system "show hidden" toggle.
   */
  hidden?: boolean
  /** Replace the track's display name (e.g. CrRendererMain → "Main"). */
  relabel?: string
}

/**
 * A pattern that targets one or more systems (processes). Mirrors
 * {@link TrackRule} but operates a level up: effects apply to the
 * system as a whole, not to any single track inside it.
 */
export interface SystemRule {
  name?: string | RegExp
  sortPriority?: number
  pinToTop?: boolean
  defaultExpanded?: boolean
  /**
   * When true, the system is omitted from the default view. The UI
   * surfaces a single "N hidden systems" reveal affordance at the
   * bottom of the timeline.
   */
  hidden?: boolean
  relabel?: string
}

/**
 * One band of the stacked overview chart. Bands aggregate the wall-clock
 * contribution of every depth-0 measure whose resolved {@link CategoryDef}
 * falls into one of `categoryIds`, mirroring Chrome DevTools' per-category
 * stacked area in the performance overview.
 */
export interface OverviewBand {
  id: string
  label: string
  color: string
  categoryIds: string[]
}

// ---------------------------------------------------------------------------
// Applied persona (output of applyPersona)
// ---------------------------------------------------------------------------

/**
 * The UI-facing view produced by {@link applyPersona}. Contains derived
 * systems/tracks (filtered, reordered, relabeled), default expand maps,
 * and the plumbing the overview chart needs to compute stacked bands.
 *
 * Each track inside `systems` keeps its original `id` so React keys and
 * expand-state keys remain stable across persona switches. The underlying
 * `Track.buffers.colors` / `Track.mipmap.levels[i].colors` arrays have
 * been repainted in place by `applyPersona` — the canvas renderer
 * consumes them unchanged.
 */
export interface AppliedPersona {
  persona: Persona
  /** Persona-filtered, persona-sorted, persona-relabeled view of systems. */
  systems: System[]
  /**
   * Tracks hidden by default, grouped by their parent system id. The UI
   * surfaces them behind a per-system "show hidden" toggle.
   */
  hiddenTracksBySystem: Record<string, Track[]>
  /**
   * Whole systems hidden by default (e.g. Process 0 / swapper). The UI
   * surfaces a single "N hidden systems" toggle at the bottom of the
   * timeline to reveal them.
   */
  hiddenSystems: System[]
  /** Default expanded state keyed by system id; undefined → UI default. */
  defaultSystemExpanded: Record<string, boolean>
  /** Default expanded state keyed by track id; undefined → UI default. */
  defaultTrackExpanded: Record<string, boolean>
  /** Re-label lookup, keyed by track id. */
  trackLabels: Record<string, string>
  /**
   * Resolver that returns the `CategoryDef.id` for any measure in the
   * trace. Exposed for the overview aggregator. Measures with no matching
   * rule resolve to the persona's catch-all category (typically `'other'`)
   * or `undefined` if the persona defines none.
   */
  resolveCategoryId(measure: Measure, track: Track, system: System): string | undefined
  /**
   * Precomputed category → overview band id lookup, derived from
   * {@link Persona.overviewBands}. `undefined` means the category is not
   * stacked in the overview (contributes to "idle" / unaccounted time).
   */
  bandForCategory: Record<string, string>
  /** Ordered band metadata for the overview chart renderer. */
  bands: OverviewBand[]
}
