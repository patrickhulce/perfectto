/**
 * Pub/sub store for the active input binding set.
 *
 * Shape mirrors `viewportStore.ts` / `selectionStore.ts` so callers
 * already familiar with those stores can subscribe/get/set with zero
 * friction. Unlike those two this store also owns:
 *  - a pointer to the currently-selected preset (built-in or custom);
 *  - the list of user-saved custom presets;
 *  - localStorage persistence so settings survive reloads.
 *
 * We expose operations rather than a raw `set` because the surface is
 * small (pick preset, rebind one cell, save/delete custom presets,
 * reset). Callers never need to replace the whole state atomically.
 */

import {
  type Action,
  type BindingSet,
  type Preset,
} from './inputBindings'
import {
  BUILTIN_PRESETS,
  DEFAULT_PRESET_ID,
  bindingsEqual,
  findBuiltinPreset,
} from './inputPresets'

export interface InputBindingsState {
  /** id of the currently-selected preset (built-in or custom). */
  activePresetId: string
  /**
   * Live bindings. Starts identical to the active preset's bindings
   * but diverges when the user rebinds individual cells without
   * saving. The settings UI compares to the preset to decide whether
   * to show a "Modified" badge.
   */
  bindings: BindingSet
  /** User-named presets, in the order they were created. */
  customPresets: Preset[]
}

export type InputBindingsListener = (state: InputBindingsState) => void

const STORAGE_KEY = 'perfectto.inputBindings.v1'

interface PersistedShape {
  activePresetId: string
  bindings: BindingSet
  customPresets: Preset[]
}

export class InputBindingsStore {
  private state: InputBindingsState
  private listeners = new Set<InputBindingsListener>()
  private storage: Storage | null

  constructor(initial: InputBindingsState, storage: Storage | null) {
    this.state = initial
    this.storage = storage
  }

  get(): InputBindingsState {
    return this.state
  }

  subscribe(fn: InputBindingsListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** All presets (built-in + custom) in display order. */
  listPresets(): Preset[] {
    return [...BUILTIN_PRESETS, ...this.state.customPresets]
  }

  findPreset(id: string): Preset | undefined {
    return (
      findBuiltinPreset(id) ?? this.state.customPresets.find(p => p.id === id)
    )
  }

  /** Look up the action bound to a gesture id. `'none'` when unbound. */
  lookup(gestureId: string): Action {
    return this.state.bindings[gestureId] ?? 'none'
  }

  /**
   * Switch to a preset, copying its bindings into the live set. No-op
   * when the preset doesn't exist (defensive; persisted state might
   * reference a deleted custom preset).
   */
  applyPreset(id: string): void {
    const preset = this.findPreset(id)
    if (!preset) return
    this.replace({
      ...this.state,
      activePresetId: preset.id,
      bindings: {...preset.bindings},
    })
  }

  /**
   * Rebind a single gesture id to `action`. Writing `'none'` removes
   * the key from the binding set so serialisation stays compact.
   */
  updateBinding(gestureId: string, action: Action): void {
    const next: BindingSet = {...this.state.bindings}
    if (action === 'none') {
      delete next[gestureId]
    } else {
      next[gestureId] = action
    }
    if (next[gestureId] === this.state.bindings[gestureId] &&
        (gestureId in next) === (gestureId in this.state.bindings)) {
      return
    }
    this.replace({...this.state, bindings: next})
  }

  /**
   * Clone the current live bindings into a new custom preset and
   * switch to it. Returns the new preset's id so the UI can select it.
   * The name is what the user typed — we don't enforce uniqueness,
   * only on id (derived from timestamp + slugified name).
   */
  saveAsPreset(name: string): string {
    const trimmed = name.trim() || 'Custom'
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'custom'
    const id = `custom-${slug}-${Date.now().toString(36)}`
    const preset: Preset = {
      id,
      name: trimmed,
      builtin: false,
      bindings: {...this.state.bindings},
    }
    this.replace({
      ...this.state,
      activePresetId: id,
      customPresets: [...this.state.customPresets, preset],
    })
    return id
  }

  /**
   * Delete a custom preset. Built-in presets can't be deleted. If the
   * deleted preset was active, falls back to the Default preset.
   */
  deletePreset(id: string): void {
    const preset = this.state.customPresets.find(p => p.id === id)
    if (!preset) return
    const customPresets = this.state.customPresets.filter(p => p.id !== id)
    let activePresetId = this.state.activePresetId
    let bindings = this.state.bindings
    if (activePresetId === id) {
      const fallback = findBuiltinPreset(DEFAULT_PRESET_ID)
      activePresetId = fallback?.id ?? DEFAULT_PRESET_ID
      bindings = fallback ? {...fallback.bindings} : bindings
    }
    this.replace({...this.state, customPresets, activePresetId, bindings})
  }

  /**
   * Reset to the Default built-in preset. Leaves custom presets
   * intact so the user doesn't lose saved work if they just wanted to
   * start over from a known baseline.
   */
  reset(): void {
    const def = findBuiltinPreset(DEFAULT_PRESET_ID)
    if (!def) return
    this.replace({
      ...this.state,
      activePresetId: def.id,
      bindings: {...def.bindings},
    })
  }

  /** True iff the live bindings match the active preset exactly. */
  isModified(): boolean {
    const preset = this.findPreset(this.state.activePresetId)
    if (!preset) return true
    return !bindingsEqual(preset.bindings, this.state.bindings)
  }

  private replace(next: InputBindingsState): void {
    this.state = next
    this.persist()
    for (const fn of this.listeners) fn(this.state)
  }

  private persist(): void {
    if (!this.storage) return
    const payload: PersistedShape = {
      activePresetId: this.state.activePresetId,
      bindings: this.state.bindings,
      customPresets: this.state.customPresets,
    }
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(payload))
    } catch {
      // Quota exceeded / private mode / disabled storage — silently drop.
    }
  }
}

function readPersisted(storage: Storage | null): PersistedShape | null {
  if (!storage) return null
  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'activePresetId' in parsed &&
      'bindings' in parsed &&
      'customPresets' in parsed
    ) {
      const p = parsed as PersistedShape
      if (
        typeof p.activePresetId === 'string' &&
        typeof p.bindings === 'object' &&
        Array.isArray(p.customPresets)
      ) {
        return p
      }
    }
  } catch {
    // Malformed JSON — fall back to defaults.
  }
  return null
}

/**
 * Create an input bindings store. Hydrates from localStorage when
 * available, otherwise seeds from the Default preset.
 */
export function createInputBindingsStore(
  storageArg?: Storage | null,
): InputBindingsStore {
  const storage =
    storageArg !== undefined
      ? storageArg
      : typeof window !== 'undefined'
        ? safeLocalStorage()
        : null

  const persisted = readPersisted(storage)
  if (persisted) {
    // If the persisted active preset is a built-in, we trust the
    // user's saved bindings verbatim (they may have tweaked it). If it
    // refers to a custom preset that no longer exists, fall back to
    // Default.
    const known =
      findBuiltinPreset(persisted.activePresetId) ??
      persisted.customPresets.find(p => p.id === persisted.activePresetId)
    if (known) {
      return new InputBindingsStore(
        {
          activePresetId: persisted.activePresetId,
          bindings: persisted.bindings,
          customPresets: persisted.customPresets,
        },
        storage,
      )
    }
  }
  const def =
    findBuiltinPreset(DEFAULT_PRESET_ID) ?? BUILTIN_PRESETS[0]
  return new InputBindingsStore(
    {
      activePresetId: def.id,
      bindings: {...def.bindings},
      customPresets: persisted?.customPresets ?? [],
    },
    storage,
  )
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export const __test__ = {STORAGE_KEY}
