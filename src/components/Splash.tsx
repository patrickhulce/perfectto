import { useRef, useState } from 'react'

export default function Splash({ onFileSelected }) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef(null)

  const handleDragOver = (e) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setIsDragging(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) onFileSelected(file)
  }

  const handleZoneClick = (e) => {
    if (e.target.closest('[data-browse-btn]')) return
    inputRef.current?.click()
  }

  const handleInputChange = (e) => {
    const file = e.target.files[0]
    if (file) onFileSelected(file)
    e.target.value = ''
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="mb-2 bg-gradient-to-br from-[#667eea] to-[#764ba2] bg-clip-text text-4xl font-bold text-transparent">
        Perfectto
      </h1>
      <p className="mb-12 text-base text-[#718096]">Perfetto perfected.</p>

      <div
        role="button"
        aria-label="Drop a trace file here or click to browse"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleZoneClick}
        className={[
          'flex min-h-[320px] w-full max-w-[640px] cursor-pointer flex-col items-center justify-center gap-5 rounded-2xl border-[3px] border-dashed p-10 text-center transition-colors',
          isDragging
            ? 'border-[#667eea] bg-[rgba(102,126,234,0.07)]'
            : 'border-[#4a5568] hover:border-[#667eea] hover:bg-[rgba(102,126,234,0.07)]',
        ].join(' ')}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#667eea"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-16 w-16 ${isDragging ? 'opacity-90' : 'opacity-50'}`}
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        <p className="text-xl font-semibold text-[#a0aec0]">Drop your trace file here</p>
        <p className="text-sm text-[#718096]">Supports any text-based performance trace format</p>
        <button
          type="button"
          data-browse-btn
          onClick={(e) => {
            e.stopPropagation()
            inputRef.current?.click()
          }}
          className="mt-2 cursor-pointer rounded-lg border-0 bg-[#667eea] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#5a67d8]"
        >
          Browse files…
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        data-testid="file-input"
        onChange={handleInputChange}
      />
    </div>
  )
}
