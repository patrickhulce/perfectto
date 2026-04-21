import type {Persona} from '../core'

interface PersonaPickerProps {
  personas: readonly Persona[]
  /** Currently active persona. */
  activeId: string
  /** Persona auto-detected for this trace. Used to show an "(auto)" hint. */
  detectedId: string
  onChange: (id: string) => void
}

/**
 * Compact persona selector for the trace header. Rendered as a native
 * <select> for accessibility and keyboard support; the option that
 * matches the trace's auto-detected persona is tagged "(auto)".
 */
export default function PersonaPicker({
  personas,
  activeId,
  detectedId,
  onChange,
}: PersonaPickerProps) {
  return (
    <label className="flex items-center gap-2 text-xs text-[#a0aec0]">
      <span className="uppercase tracking-wider text-[10px] text-[#718096]">Persona</span>
      <select
        value={activeId}
        onChange={e => onChange(e.target.value)}
        className="cursor-pointer rounded border border-[#4a5568] bg-[#0b0f17] px-2 py-1 text-[#e2e8f0] hover:border-[#667eea] focus:border-[#667eea] focus:outline-none"
        aria-label="Trace interpretation persona"
      >
        {personas.map(p => (
          <option key={p.id} value={p.id} title={p.description}>
            {p.name}
            {p.id === detectedId ? ' (auto)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
