/**
 * Phase 3 feature flag. The skirt is on by default; passing `?skirt=off`
 * (or `?skirt=0`) in the URL disables it for one release so we can compare
 * the cheap-translate path against the all-redraws baseline if a regression
 * surfaces. Mirrors the rollout style suggested in MISSION_PERFORMANCE.md
 * for the Phase 1 cutover.
 */

let cached: boolean | null = null

export function isSkirtEnabled(): boolean {
  if (cached !== null) return cached
  if (typeof window === 'undefined' || typeof window.location === 'undefined') {
    cached = true
    return cached
  }
  try {
    const params = new URLSearchParams(window.location.search)
    const value = params.get('skirt')
    if (value === 'off' || value === '0' || value === 'false') {
      cached = false
      return cached
    }
  } catch {
    // URL parsing errors (e.g. SSR or weird hash routes) — fall through.
  }
  cached = true
  return cached
}

/** Visible for tests so each spec can flip between modes. */
export function __resetSkirtFlag(): void {
  cached = null
}
