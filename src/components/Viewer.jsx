import { formatBytes } from '../utils/formatBytes.js'
import { PREVIEW_CHARS } from '../utils/loadFile.js'

export default function Viewer({ trace, onBack }) {
  const { name, size, preview, totalLength, truncated } = trace

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex items-center gap-4 border-b border-[#2d3748] bg-[#1a202c] px-6 py-4">
        <button
          type="button"
          onClick={onBack}
          className="cursor-pointer rounded-lg border border-[#4a5568] bg-transparent px-4 py-1.5 text-sm text-[#a0aec0] transition-colors hover:border-[#667eea] hover:text-[#667eea]"
        >
          ← Back
        </button>
        <h2 className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[1.1rem] font-semibold text-[#e2e8f0]">
          {name}
        </h2>
        <span className="whitespace-nowrap text-xs text-[#718096]">{formatBytes(size)}</span>
      </div>

      {truncated && (
        <div className="mx-6 mb-6 rounded-lg border border-[rgba(237,137,54,0.4)] bg-[rgba(237,137,54,0.15)] px-4 py-3 text-sm text-[#ed8936]">
          {`Showing first ${PREVIEW_CHARS.toLocaleString()} of ${totalLength.toLocaleString()} characters.`}
        </div>
      )}

      <pre className="m-6 flex-1 overflow-auto whitespace-pre break-all rounded-xl bg-[#1a202c] p-5 font-mono text-xs leading-relaxed text-[#a8d8a8]">
        {preview}
      </pre>
    </div>
  )
}
