export interface LoadedFile {
  name: string
  /** Compressed size on disk (`File.size`). */
  size: number
  /**
   * Best-effort *uncompressed* size in bytes. Set when the file looks
   * gzipped and its ISIZE trailer is plausible; `undefined` for plain
   * files (use {@link size}) or for gzipped files whose trailer can't
   * be trusted (e.g. the original payload was ≥ 4 GiB and ISIZE wraps).
   *
   * Consumers should prefer `uncompressedSize ?? size` as the
   * progress-bar denominator so a 73 MB `.gz` carrying 1.3 GiB of JSON
   * doesn't spike the bar to "800 MB of 73 MB".
   */
  uncompressedSize?: number
  stream: ReadableStream<Uint8Array>
}

const GZIP_MAGIC_0 = 0x1f
const GZIP_MAGIC_1 = 0x8b

export async function loadFile(file: File): Promise<LoadedFile> {
  const uncompressedSize = await tryReadGzipUncompressedSize(file)
  return {
    name: file.name,
    size: file.size,
    uncompressedSize,
    stream: file.stream(),
  }
}

/**
 * Reads the gzip ISIZE trailer (last 4 bytes, little-endian uint32) when
 * the file looks gzipped. ISIZE is uncompressed-bytes-mod-2^32, which is
 * exact for any payload < 4 GiB and wraps around above that — we reject
 * anything that wraps below the compressed size or below a sanity floor.
 *
 * Returns `undefined` for any file that doesn't look gzipped, or whose
 * trailer fails the sanity check. The bar then falls back to the
 * compressed size (which still bounds the *parsing* phase reasonably,
 * just not the decompressed-bytes counter the worker emits).
 */
async function tryReadGzipUncompressedSize(file: File): Promise<number | undefined> {
  if (file.size < 18) return undefined // gzip header(10) + trailer(8) minimum

  const looksGzippedByName = /\.(gz|gzip)$/i.test(file.name)

  // Read the first 2 bytes for magic; cheap, and saves the trailer read
  // when we already know the file isn't gzipped by name *and* doesn't
  // start with the magic header.
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer())
  const looksGzippedByMagic =
    head.byteLength >= 2 && head[0] === GZIP_MAGIC_0 && head[1] === GZIP_MAGIC_1
  if (!looksGzippedByName && !looksGzippedByMagic) return undefined

  const trailer = new Uint8Array(await file.slice(file.size - 4, file.size).arrayBuffer())
  if (trailer.byteLength !== 4) return undefined
  const isize =
    trailer[0] | (trailer[1] << 8) | (trailer[2] << 16) | (trailer[3] << 24)
  // Force unsigned interpretation — JS bitwise operates on int32.
  const uncompressed = isize >>> 0

  // ISIZE wraps mod 2^32. If the reported size is smaller than the
  // *compressed* size we're almost certainly past the wrap and the
  // value is meaningless; same if it's absurdly small for what looked
  // like a gzipped payload. In either case, leave it undefined and let
  // the caller fall back to the compressed size.
  if (uncompressed < file.size) return undefined
  if (uncompressed < 1024) return undefined

  return uncompressed
}
