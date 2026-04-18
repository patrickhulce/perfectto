export interface LoadedFile {
  name: string
  size: number
  stream: ReadableStream<Uint8Array>
}

export function loadFile(file: File): LoadedFile {
  return {
    name: file.name,
    size: file.size,
    stream: file.stream(),
  }
}
