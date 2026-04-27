import type {ParsedTrace} from '../types'
import {ML_PERSONA} from './personas/ml'
import {RAW_PERSONA} from './personas/raw'
import {WEB_PERSONA} from './personas/web'
import type {Persona} from './types'

/**
 * Built-in personas, ordered as they appear in the picker. `Raw` lives
 * last as the always-available fallback.
 */
export const BUILTIN_PERSONAS: readonly Persona[] = [
  WEB_PERSONA,
  ML_PERSONA,
  RAW_PERSONA,
]

/**
 * Pick the highest-scoring persona for a trace. Ties break toward the
 * persona that appears earlier in {@link BUILTIN_PERSONAS}. `Raw` will
 * always match (score 0.5) so a trace with no specialized persona still
 * gets a valid result.
 */
export function detectPersona(
  trace: ParsedTrace,
  personas: readonly Persona[] = BUILTIN_PERSONAS,
): Persona {
  let best: Persona = personas[personas.length - 1] ?? RAW_PERSONA
  let bestScore = -Infinity
  for (const p of personas) {
    const score = p.match(trace)
    if (score > bestScore) {
      best = p
      bestScore = score
    }
  }
  return best
}

export function findPersona(
  id: string,
  personas: readonly Persona[] = BUILTIN_PERSONAS,
): Persona | undefined {
  return personas.find(p => p.id === id)
}
