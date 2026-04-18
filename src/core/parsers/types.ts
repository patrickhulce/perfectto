import type {ParseProgress, ParsedTrace, TraceSource} from '../types'

export interface FinalizeOptions {
  signal?: AbortSignal
  onProgress?: (progress: ParseProgress) => void
  /** Current cumulative bytes read, forwarded to `onProgress` during finalize. */
  bytesRead?: number
  /** Current stream index, forwarded to `onProgress` during finalize. */
  streamIndex?: number
}

export interface TraceParser {
  write(chunk: Uint8Array): void
  finalize(source: TraceSource, options?: FinalizeOptions): Promise<ParsedTrace>
}

export interface TraceParserConstructor {
  new (): TraceParser
  readonly MAGIC_PATTERN: Uint8Array
  readonly parserName: string
}
