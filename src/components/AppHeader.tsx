import {useState} from 'react'
import type {Persona} from '../core'
import PersonaPicker from './PersonaPicker'
import SettingsPanel, {SettingsCog} from './SettingsPanel'
import type {InputBindingsStore} from './timeline/inputBindingsStore'

/**
 * Minimal pane shape the header needs for the compound title. Mirrors
 * the subset of {@link AggregatorPaneInfo} we care about — name only —
 * so callers can pass either type in without a wider import surface.
 */
export interface AppHeaderPaneInfo {
  /** Display name shown in the compound title (e.g. the trace filename). */
  name: string
}

interface AppHeaderProps {
  /**
   * Loaded panes (those that already have a parsed trace). Drives the
   * compound title: 1 pane → just its filename; 2 panes →
   * `"a.json vs. b.json"`. Mid-parse panes are intentionally excluded
   * so the title doesn't flicker while the second drop loads.
   */
  panes: readonly AppHeaderPaneInfo[]
  /** Returns to the splash by closing every pane. */
  onBack: () => void
  /**
   * Persona affordance — global across panes. When all three of these
   * are provided the picker renders; otherwise it's omitted (e.g. the
   * brief window between mount and the first successful load when the
   * detected id isn't available yet).
   */
  personas?: readonly Persona[]
  activePersonaId?: string
  detectedPersonaId?: string
  onPersonaChange?: (id: string) => void
  /**
   * Input-bindings store. When provided, the settings cog is shown in
   * the top-right of the header and opens the flipout panel.
   */
  bindingsStore?: InputBindingsStore
}

/**
 * Top-of-app header (one instance, mounted by {@link App}). Hosts the
 * back-to-splash button, the compound trace title, the persona
 * picker, and the settings cog. Per-trace metadata (filename, size,
 * compaction pill, download button, close-pane) lives in the
 * per-pane {@link TracePaneHeader} instead so a multi-trace layout
 * doesn't end up with two thick header bars stacked vertically.
 *
 * The compound title degenerates to a single filename when only one
 * pane is loaded, so the same component covers both N=1 and N=2 with
 * no fork.
 */
export default function AppHeader({
  panes,
  onBack,
  personas,
  activePersonaId,
  detectedPersonaId,
  onPersonaChange,
  bindingsStore,
}: AppHeaderProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const title = compoundTitle(panes)
  return (
    <>
      <div className="flex items-center gap-4 border-b border-[#2d3748] bg-[#1a202c] px-6 py-4">
        <button
          type="button"
          onClick={onBack}
          className="cursor-pointer rounded-lg border border-[#4a5568] bg-transparent px-4 py-1.5 text-sm text-[#a0aec0] transition-colors hover:border-[#667eea] hover:text-[#667eea]"
        >
          ← Back
        </button>
        <h1
          className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[1.1rem] font-semibold text-[#e2e8f0]"
          title={title}
          data-testid="app-header-title"
        >
          {title}
        </h1>
        {personas && activePersonaId && detectedPersonaId && onPersonaChange && (
          <PersonaPicker
            personas={personas}
            activeId={activePersonaId}
            detectedId={detectedPersonaId}
            onChange={onPersonaChange}
          />
        )}
        {bindingsStore && (
          <SettingsCog onClick={() => setSettingsOpen(v => !v)} />
        )}
      </div>
      {bindingsStore && (
        <SettingsPanel
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          bindingsStore={bindingsStore}
        />
      )}
    </>
  )
}

/**
 * Build the global header title from the loaded panes.
 *
 *  - 0 panes: app name (briefly visible during the gap between drop
 *    and the first successful load — the splash itself owns its own
 *    branding so this is a fallback only).
 *  - 1 pane: just that trace's filename.
 *  - 2+ panes: filenames joined with `" vs. "` so the user can see at
 *    a glance which traces they're comparing.
 *
 * Long titles fall back to the OS tooltip via the `<h1 title=...>`
 * attribute on the rendered element.
 */
export function compoundTitle(panes: readonly AppHeaderPaneInfo[]): string {
  if (panes.length === 0) return 'Perfectto'
  if (panes.length === 1) return panes[0].name
  return panes.map(p => p.name).join(' vs. ')
}
