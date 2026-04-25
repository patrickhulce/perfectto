import type {ParseProgress, ParsedTrace, TraceSource} from '../types'

export interface FinalizeOptions {
  signal?: AbortSignal
  onProgress?: (progress: ParseProgress) => void
  /** Current cumulative bytes read, forwarded to `onProgress` during finalize. */
  bytesRead?: number
  /** Current stream index, forwarded to `onProgress` during finalize. */
  streamIndex?: number
  /**
   * Set when the universal parser stopped reading early (e.g. `maxBytes`
   * cap hit). Format-specific parsers should treat this as permission
   * to skip end-of-stream invariants — the JSON probably won't close
   * its root brace, the protobuf trailer is missing — and finalize
   * over whatever events were emitted before the cut.
   */
  truncated?: boolean
}

export interface TraceParser {
  write(chunk: Uint8Array): void
  finalize(source: TraceSource, options?: FinalizeOptions): Promise<ParsedTrace>
}

export interface TraceParserConstructor {
  /**
   * Parsers may accept an opaque options object forwarded by the universal
   * entry. Each parser picks out the fields it recognises and ignores the
   * rest; unrecognized options must not throw.
   */
  new (options?: unknown): TraceParser
  readonly MAGIC_PATTERN: Uint8Array
  readonly parserName: string
}
