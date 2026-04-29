/**
 * Error card rendered when `parseTraceInWorker` rejects with anything
 * other than an `AbortError`. Surfaces the worker's error message + a
 * dismiss path so an OOM, unexpected trace format, or parse bug doesn't
 * leave the user on an unrecoverable blank page.
 *
 * Sized to fill its parent (a `TracePane` slot, or the whole viewport
 * when no other panes exist) — `min-h-0 flex-1` instead of the legacy
 * `min-h-screen` so multi-pane layouts can stack errored panes
 * alongside loaded ones without each one demanding the full viewport.
 */
export interface ParseErrorState {
  name: string
  message: string
  detail?: string
}

interface ParseErrorViewProps {
  error: ParseErrorState
  onDismiss: () => void
}

export default function ParseErrorView({error, onDismiss}: ParseErrorViewProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center p-8">
      <div className="flex w-full max-w-[640px] flex-col gap-5 rounded-2xl border border-[#fc8181]/60 bg-[rgba(252,129,129,0.06)] p-8">
        <h1 className="text-2xl font-semibold text-[#fc8181]">
          Couldn&apos;t parse that trace
        </h1>
        <div>
          <p className="truncate text-sm text-[#a0aec0]" title={error.name}>
            {error.name}
          </p>
          <p className="mt-2 text-sm text-[#e2e8f0]">{error.message}</p>
          {error.detail && (
            <p className="mt-2 text-xs uppercase tracking-wider text-[#718096]">
              {error.detail}
            </p>
          )}
        </div>
        <ul className="list-disc space-y-1 pl-5 text-xs text-[#a0aec0]">
          <li>
            If the file is over ~2 GB, try the Chrome DevTools sample-rate knob or
            pre-split the trace before loading.
          </li>
          <li>
            Gzipped traces (`.gz`, or any file whose first two bytes are
            `1f 8b`) are decompressed automatically; other archive
            wrappers (`.zip`, `.tar.gz`) need to be unpacked first.
          </li>
          <li>
            Browser worker OOMs surface here; closing other tabs can free the
            headroom we need.
          </li>
        </ul>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onDismiss}
            className="cursor-pointer rounded-lg border border-[#4a5568] bg-transparent px-4 py-1.5 text-sm text-[#a0aec0] transition-colors hover:border-[#667eea] hover:text-[#667eea]"
          >
            Try another file
          </button>
        </div>
      </div>
    </div>
  )
}
