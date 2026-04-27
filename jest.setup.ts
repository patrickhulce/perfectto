import '@testing-library/jest-dom'
import {
  CompressionStream,
  DecompressionStream,
  ReadableStream,
  TransformStream,
  WritableStream,
} from 'node:stream/web'
import { TextDecoder, TextEncoder } from 'node:util'

// jsdom does not polyfill these Web APIs; expose the Node implementations so
// streaming-parser tests and `File.stream()` behave like in the browser.
const g = globalThis as unknown as Record<string, unknown>
if (typeof g.TextEncoder === 'undefined') g.TextEncoder = TextEncoder
if (typeof g.TextDecoder === 'undefined') g.TextDecoder = TextDecoder
if (typeof g.ReadableStream === 'undefined') g.ReadableStream = ReadableStream
if (typeof g.WritableStream === 'undefined') g.WritableStream = WritableStream
if (typeof g.TransformStream === 'undefined') g.TransformStream = TransformStream
if (typeof g.DecompressionStream === 'undefined') g.DecompressionStream = DecompressionStream
if (typeof g.CompressionStream === 'undefined') g.CompressionStream = CompressionStream

// jsdom's Blob/File lacks both `.arrayBuffer()` and `.stream()`; polyfill them
// so the streaming parser can consume File objects the same way in tests as in
// the browser.
const blobProto = Blob.prototype as unknown as {
  arrayBuffer?: () => Promise<ArrayBuffer>
  stream?: () => ReadableStream<Uint8Array>
}
if (typeof blobProto.arrayBuffer !== 'function') {
  blobProto.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error ?? new Error('FileReader error'))
      reader.readAsArrayBuffer(this)
    })
  }
}
if (typeof blobProto.stream !== 'function') {
  blobProto.stream = function stream(this: Blob): ReadableStream<Uint8Array> {
    const blob = this
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const buf = await blob.arrayBuffer()
        if (buf.byteLength > 0) controller.enqueue(new Uint8Array(buf))
        controller.close()
      },
    })
  }
}
