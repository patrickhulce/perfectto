import type {ParsedTrace} from '../types'
import {RAW_PROFILE} from './profiles/raw'
import {WEB_DEV_PROFILE} from './profiles/webDev'
import type {Profile} from './types'

/**
 * Built-in profiles, ordered as they appear in the picker. `Raw` lives
 * last as the always-available fallback.
 */
export const BUILTIN_PROFILES: readonly Profile[] = [WEB_DEV_PROFILE, RAW_PROFILE]

/**
 * Pick the highest-scoring profile for a trace. Ties break toward the
 * profile that appears earlier in {@link BUILTIN_PROFILES}. `Raw` will
 * always match (score 0.5) so a trace with no specialized profile still
 * gets a valid result.
 */
export function detectProfile(
  trace: ParsedTrace,
  profiles: readonly Profile[] = BUILTIN_PROFILES,
): Profile {
  let best: Profile = profiles[profiles.length - 1] ?? RAW_PROFILE
  let bestScore = -Infinity
  for (const p of profiles) {
    const score = p.match(trace)
    if (score > bestScore) {
      best = p
      bestScore = score
    }
  }
  return best
}

export function findProfile(
  id: string,
  profiles: readonly Profile[] = BUILTIN_PROFILES,
): Profile | undefined {
  return profiles.find(p => p.id === id)
}
