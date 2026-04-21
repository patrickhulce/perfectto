import type {Profile} from '../types'

/**
 * No-op profile: no colorization overrides, no sort changes, nothing
 * hidden, no overview stacking. Serves as the always-available fallback
 * so the UI never has to handle a `null` profile. Scoring 0.5 lets any
 * real profile with a positive match score win auto-detection while
 * still being above 0 so it's preferred over "no match" traces.
 */
export const RAW_PROFILE: Profile = {
  id: 'raw',
  name: 'Raw',
  description: 'No interpretation — show the trace exactly as parsed.',
  match: () => 0.5,
  categories: [],
  colorRules: [],
  trackRules: [],
  overviewBands: [],
}
