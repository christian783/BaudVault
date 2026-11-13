// Deflate compression for the Vault_Engine (design.md, "Vault_Engine").
//
// Both directions use the zlib format (RFC 1950) through CompressionStream and
// DecompressionStream. Decompression is capped (Requirement 1.7) and turns a
// malformed or truncated stream into a FormatError (Requirement 1.8).
//
// The bytes passing through here are Plaintext or decrypted Envelope contents,
// so nothing is logged, no error carries data or a `cause` (Requirements 8.4,
// 8.9), and every intermediate buffer is zeroed once it is no longer needed.

import { concat, zeroize } from '../core/bytes'
import { FormatError } from '../core/errors'

/**
 * Largest decompressed output accepted, equal to the Plaintext limit (15,360
 * bytes). It lives here so `vault.ts` can reuse it without a circular import.
 */
export const MAX_DECOMPRESSED_BYTES = 15_360

/** Compresses `input` with Deflate in the zlib format (RFC 1950). */
export async function compress(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const chunks = await transform(new CompressionStream('deflate'), input, Number.POSITIVE_INFINITY)
  if (chunks === 'too-long' || chunks === 'malformed') {
    // Compressing in-memory bytes cannot fail on valid input.
    throw new Error('compression failed')
  }
  return collect(chunks)
}

/**
 * Decompresses a zlib-format Deflate stream.
 *
 * @param maxBytes the largest output accepted; defaults to `MAX_DECOMPRESSED_BYTES`
 * @throws FormatError if the output would exceed `maxBytes`, or the input is
 *   malformed or truncated. Reading stops as soon as the cap is passed.
 */
export async function decompress(
  input: Uint8Array,
  maxBytes: number = MAX_DECOMPRESSED_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes out of range')
  const chunks = await transform(new DecompressionStream('deflate'), input, maxBytes)
  if (chunks === 'too-long') throw new FormatError('decompressed output exceeds', maxBytes, 'bytes')
  if (chunks === 'malformed') throw new FormatError('malformed deflate stream')
  return collect(chunks)
}

type Transformer = CompressionStream | DecompressionStream

/**
 * Pushes `input` through `stream` and reads the output chunk by chunk.
 * Returns the output chunks, or a reason with every chunk already zeroed.
 */
async function transform(
  stream: Transformer,
  input: Uint8Array,
  maxBytes: number,
): Promise<Uint8Array[] | 'too-long' | 'malformed'> {
  const { view, copied } = arrayBufferView(input)

  // Write and close without awaiting, so the read loop below drains the
  // output and keeps backpressure from stalling the write. When the stream
  // errors or the read side cancels it, these promises reject; the rejection
  // is expected and handled here so it never surfaces as unhandled.
  const writer = stream.writable.getWriter()
  const writing = writer
    .write(view)
    .then(() => writer.close())
    .catch(() => undefined)

  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let outcome: 'done' | 'too-long' | 'malformed' = 'done'
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
      if (total > maxBytes) {
        outcome = 'too-long'
        await reader.cancel().catch(() => undefined)
        break
      }
    }
  } catch {
    outcome = 'malformed'
  } finally {
    reader.releaseLock()
  }

  await writing
  if (copied) zeroize(view)

  if (outcome !== 'done') {
    zeroize(...chunks)
    return outcome
  }
  return chunks
}

/** Joins the chunks into one array and zeroes the chunks. */
function collect(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = concat(...chunks)
  zeroize(...chunks)
  return out
}

/**
 * Streams accept only views over an `ArrayBuffer`. Returns `bytes` itself when
 * it already is one, otherwise a copy the caller must zero after use.
 */
function arrayBufferView(bytes: Uint8Array): { view: Uint8Array<ArrayBuffer>; copied: boolean } {
  if (bytes.buffer instanceof ArrayBuffer) {
    return { view: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), copied: false }
  }
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return { view: copy, copied: true }
}
