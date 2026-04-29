import {useCallback, useEffect, useState} from 'react'
import {
  ACTION_LABELS,
  ALL_ACTIONS,
  formatGestureLabel,
  type Action,
} from './timeline/inputBindings'
import type {InputBindingsStore} from './timeline/inputBindingsStore'

interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  bindingsStore: InputBindingsStore
}

/**
 * List of gesture rows the settings matrix shows. Grouped so the UI
 * can render section headers. These are the ones every user should
 * be able to discover and rebind; rare combinations (e.g. four
 * modifiers on a wheel) are intentionally omitted so the panel stays
 * scannable. Advanced users can still preset-author them by saving
 * a custom preset from a hand-edited localStorage blob.
 */
const MATRIX_ROWS: readonly {
  section: 'Wheel' | 'Drag' | 'Click' | 'Keyboard'
  gestureId: string
}[] = [
  {section: 'Wheel', gestureId: 'wheel'},
  {section: 'Wheel', gestureId: 'shift+wheel'},
  {section: 'Wheel', gestureId: 'ctrl+wheel'},
  {section: 'Wheel', gestureId: 'cmd+wheel'},
  {section: 'Wheel', gestureId: 'opt+wheel'},

  {section: 'Drag', gestureId: 'leftDrag'},
  {section: 'Drag', gestureId: 'shift+leftDrag'},
  {section: 'Drag', gestureId: 'ctrl+leftDrag'},
  {section: 'Drag', gestureId: 'cmd+leftDrag'},
  {section: 'Drag', gestureId: 'opt+leftDrag'},
  {section: 'Drag', gestureId: 'middleDrag'},

  {section: 'Click', gestureId: 'click'},
  {section: 'Click', gestureId: 'shift+click'},

  {section: 'Keyboard', gestureId: 'key:W'},
  {section: 'Keyboard', gestureId: 'key:A'},
  {section: 'Keyboard', gestureId: 'key:S'},
  {section: 'Keyboard', gestureId: 'key:D'},
  {section: 'Keyboard', gestureId: 'key:Z'},
  {section: 'Keyboard', gestureId: 'shift+key:Z'},
  {section: 'Keyboard', gestureId: 'key:Escape'},
  {section: 'Keyboard', gestureId: 'key:ArrowLeft'},
  {section: 'Keyboard', gestureId: 'key:ArrowRight'},
  {section: 'Keyboard', gestureId: 'key:ArrowUp'},
  {section: 'Keyboard', gestureId: 'key:ArrowDown'},
]

const SECTIONS: readonly ('Wheel' | 'Drag' | 'Click' | 'Keyboard')[] = [
  'Wheel',
  'Drag',
  'Click',
  'Keyboard',
]

/**
 * Flipout drawer for input-binding configuration.
 *
 * Layout: fixed panel anchored to the right edge, 400px wide, full
 * height. Backdrop captures outside clicks. Matches the dark palette
 * used elsewhere (`#0b0f17` / `#1a202c` / `#2d3748`).
 */
export default function SettingsPanel({
  open,
  onClose,
  bindingsStore,
}: SettingsPanelProps) {
  // Subscribe to the store via a tiny state slot. We don't render the
  // store's data shape directly — we snapshot it on every change and
  // re-render. This is cheap (the store only changes on user
  // interaction, never in a hot loop).
  const [snapshot, setSnapshot] = useState(() => bindingsStore.get())
  useEffect(() => {
    const unsub = bindingsStore.subscribe(s => setSnapshot({...s}))
    // Also sync on mount in case the store changed between render
    // and subscribe.
    setSnapshot({...bindingsStore.get()})
    return unsub
  }, [bindingsStore])

  const [saveMode, setSaveMode] = useState(false)
  const [saveName, setSaveName] = useState('')

  // Close on Escape for discoverability — matches the gesture users
  // already know from the picker/persona modal patterns in the app.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, {capture: true})
    return () => window.removeEventListener('keydown', onKey, {capture: true})
  }, [open, onClose])

  const presets = bindingsStore.listPresets()
  const activePreset = bindingsStore.findPreset(snapshot.activePresetId)
  const isModified = bindingsStore.isModified()

  const handlePresetChange = useCallback(
    (id: string) => {
      bindingsStore.applyPreset(id)
    },
    [bindingsStore],
  )

  const handleCellChange = useCallback(
    (gestureId: string, action: Action) => {
      bindingsStore.updateBinding(gestureId, action)
    },
    [bindingsStore],
  )

  const handleSave = useCallback(() => {
    if (!saveName.trim()) return
    bindingsStore.saveAsPreset(saveName.trim())
    setSaveName('')
    setSaveMode(false)
  }, [bindingsStore, saveName])

  const handleDelete = useCallback(() => {
    if (!activePreset || activePreset.builtin) return
    bindingsStore.deletePreset(activePreset.id)
  }, [bindingsStore, activePreset])

  const handleReset = useCallback(() => {
    bindingsStore.reset()
  }, [bindingsStore])

  if (!open) return null

  return (
    <>
      <div
        role="presentation"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/40"
      />
      <aside
        role="dialog"
        aria-label="Input bindings settings"
        className="fixed right-0 top-0 z-50 flex h-screen w-[420px] flex-col border-l border-[#2d3748] bg-[#1a202c] text-[#e2e8f0] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-[#2d3748] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">Input bindings</h2>
            <p className="text-xs text-[#718096]">
              Mouse, wheel, and keyboard gestures
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="cursor-pointer rounded p-1 text-[#a0aec0] hover:bg-[#2d3748] hover:text-[#e2e8f0]"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </header>

        <div className="flex flex-col gap-3 border-b border-[#2d3748] px-5 py-4">
          <label className="flex flex-col gap-1 text-xs text-[#a0aec0]">
            <span className="uppercase tracking-wider text-[10px] text-[#718096]">
              Preset
            </span>
            <div className="flex gap-2">
              <select
                value={snapshot.activePresetId}
                onChange={e => handlePresetChange(e.target.value)}
                className="flex-1 cursor-pointer rounded border border-[#4a5568] bg-[#0b0f17] px-2 py-1.5 text-sm text-[#e2e8f0] hover:border-[#667eea] focus:border-[#667eea] focus:outline-none"
              >
                <optgroup label="Built-in">
                  {presets
                    .filter(p => p.builtin)
                    .map(p => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </optgroup>
                {presets.some(p => !p.builtin) && (
                  <optgroup label="Custom">
                    {presets
                      .filter(p => !p.builtin)
                      .map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </optgroup>
                )}
              </select>
              {isModified && (
                <span
                  className="flex items-center rounded border border-[#f6ad55] px-2 text-[10px] uppercase tracking-wider text-[#f6ad55]"
                  title="Live bindings differ from the selected preset"
                >
                  Modified
                </span>
              )}
            </div>
          </label>
          {saveMode ? (
            <div className="flex gap-2">
              <input
                autoFocus
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSave()
                  else if (e.key === 'Escape') {
                    setSaveMode(false)
                    setSaveName('')
                  }
                }}
                placeholder="Preset name"
                className="flex-1 rounded border border-[#4a5568] bg-[#0b0f17] px-2 py-1 text-sm text-[#e2e8f0] focus:border-[#667eea] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={!saveName.trim()}
                className="cursor-pointer rounded border border-[#667eea] bg-[#667eea]/20 px-3 py-1 text-xs text-[#cbd5e0] hover:bg-[#667eea]/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setSaveMode(false)
                  setSaveName('')
                }}
                className="cursor-pointer rounded border border-[#4a5568] px-3 py-1 text-xs text-[#a0aec0] hover:border-[#667eea] hover:text-[#e2e8f0]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setSaveMode(true)}
                className="cursor-pointer rounded border border-[#4a5568] px-3 py-1 text-xs text-[#a0aec0] hover:border-[#667eea] hover:text-[#e2e8f0]"
              >
                Save as…
              </button>
              {activePreset && !activePreset.builtin && (
                <button
                  type="button"
                  onClick={handleDelete}
                  className="cursor-pointer rounded border border-[#4a5568] px-3 py-1 text-xs text-[#a0aec0] hover:border-[#fc8181] hover:text-[#fc8181]"
                >
                  Delete preset
                </button>
              )}
              <button
                type="button"
                onClick={handleReset}
                className="cursor-pointer rounded border border-[#4a5568] px-3 py-1 text-xs text-[#a0aec0] hover:border-[#667eea] hover:text-[#e2e8f0]"
              >
                Reset to Default
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {SECTIONS.map(section => {
            const rows = MATRIX_ROWS.filter(r => r.section === section)
            if (rows.length === 0) return null
            return (
              <section key={section} className="mb-5">
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[#718096]">
                  {section}
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {rows.map(({gestureId}) => {
                    const action: Action =
                      (snapshot.bindings[gestureId] as Action | undefined) ?? 'none'
                    return (
                      <li
                        key={gestureId}
                        className="grid grid-cols-[1fr_1.2fr] items-center gap-3"
                      >
                        <label
                          htmlFor={`binding-${gestureId}`}
                          className="truncate text-xs text-[#cbd5e0]"
                          title={formatGestureLabel(gestureId)}
                        >
                          {formatGestureLabel(gestureId)}
                        </label>
                        <select
                          id={`binding-${gestureId}`}
                          value={action}
                          onChange={e =>
                            handleCellChange(gestureId, e.target.value as Action)
                          }
                          className="cursor-pointer rounded border border-[#4a5568] bg-[#0b0f17] px-2 py-1 text-xs text-[#e2e8f0] hover:border-[#667eea] focus:border-[#667eea] focus:outline-none"
                        >
                          {ALL_ACTIONS.map(a => (
                            <option key={a} value={a}>
                              {ACTION_LABELS[a]}
                            </option>
                          ))}
                        </select>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
          <p className="mt-6 text-[11px] leading-relaxed text-[#718096]">
            Trackpad two-finger scroll and pinch are always handled natively
            (scroll and zoom, respectively) regardless of the selected preset.
            Only physical mouse-wheel events, drags, and keys are routed
            through the bindings above.
          </p>
        </div>
      </aside>
    </>
  )
}

/** Inline cog icon used by the trigger button in `AppHeader`. */
export function SettingsCog({
  onClick,
  title,
}: {
  onClick: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open settings"
      title={title ?? 'Input bindings'}
      className="cursor-pointer rounded-lg border border-[#4a5568] bg-transparent p-1.5 text-[#a0aec0] transition-colors hover:border-[#667eea] hover:text-[#667eea]"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  )
}
