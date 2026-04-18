import type {ParsedTrace, TraceSource} from '../types'

export interface TraceParser {
  write(chunk: Uint8Array): void
  finalize(source: TraceSource): Promise<ParsedTrace>
}

export interface TraceParserConstructor {
  new (): TraceParser
  readonly MAGIC_PATTERN: Uint8Array
  readonly parserName: string
}
