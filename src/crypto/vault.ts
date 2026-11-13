// Vault_Engine: seal and open (design.md, "Vault_Engine" and "Envelope v1").
//
// Seal compresses the Plaintext, derives an AES-256-GCM key from the Password
// with PBKDF2-HMAC-SHA-256, and encrypts with the 33-byte Envelope header as
// additional authenticated data. Open reverses the steps and caps the
// decompressed output.
//
// Plaintext, Password bytes, and decrypted bytes are never logged, never put
// in an error, and zeroed once they are no longer needed (Requirements 8.4,
// 8.9). Salts and IVs come only from `crypto.getRandomValues` (Requirement 8.5).

import { concat, readUint32BE, writeUint32BE, zeroize } from '../core/bytes'
import { AuthenticationError, FormatError, InputError } from '../core/errors'
import { compress, decompress, MAX_DECOMPRESSED_BYTES } from './compress'

/** PBKDF2 iteration count used for every production seal (decision D2). */
export const PBKDF2_ITERATIONS = 600_000
/** Largest Plaintext accepted by `seal`, and largest output `open` returns. */
export const MAX_PLAINTEXT_BYTES = MAX_DECOMPRESSED_BYTES
/** Smallest iteration count accepted in an Envelope or by `seal`. */
export const MIN_ITERATIONS = 1_000
/** Largest iteration count accepted in an Envelope or by `seal`. */
export const MAX_ITERATIONS = 5_000_000

const VERSION = 0x01
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const OFFSET_ITERATIONS = 1
const OFFSET_SALT = 5
const OFFSET_IV = OFFSET_SALT + SALT_BYTES
/** Bytes 0 to 32: version, iterations, salt, IV. Also the AES-GCM additional data. */
const HEADER_BYTES = OFFSET_IV + IV_BYTES
/** Header plus tag plus at least one ciphertext byte. */
const MIN_ENVELOPE_BYTES = HEADER_BYTES + TAG_BYTES + 1

/**
 * Compresses and encrypts `plaintext` under `password` and returns an Envelope
 * in the v1 layout.
 *
 * `options.iterations` exists for tests only; the UI never passes it.
 *
 * @throws InputError if `plaintext` is empty or longer than 15,360 bytes, the
 *   Password is empty, or `options.iterations` is not an integer from 1,000
 *   to 5,000,000
 */
export async function seal(
  plaintext: Uint8Array,
  password: string,
  options?: { iterations?: number },
): Promise<Uint8Array<ArrayBuffer>> {
  const iterations = options?.iterations ?? PBKDF2_ITERATIONS
  if (plaintext.length < 1 || plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new InputError('plaintext must be 1 to 15360 bytes, got', plaintext.length, 'bytes')
  }
  if (password.length === 0) throw new InputError('password must not be empty')
  assertNoNullCharacter(password)
  if (!isValidIterations(iterations)) {
    throw new InputError('iterations must be an integer from 1000 to 5000000')
  }

  const header = new Uint8Array(HEADER_BYTES)
  header[0] = VERSION
  writeUint32BE(header, OFFSET_ITERATIONS, iterations)
  const salt = header.subarray(OFFSET_SALT, OFFSET_SALT + SALT_BYTES)
  const iv = header.subarray(OFFSET_IV, OFFSET_IV + IV_BYTES)
  crypto.getRandomValues(salt)
  crypto.getRandomValues(iv)

  const compressed = await compress(plaintext)
  try {
    const key = await deriveKey(password, salt, iterations)
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: header, tagLength: TAG_BYTES * 8 },
      key,
      compressed,
    )
    return concat(header, new Uint8Array(sealed))
  } finally {
    zeroize(compressed)
  }
}

/**
 * Decrypts and decompresses an Envelope and returns the Plaintext.
 *
 * @throws FormatError if the Envelope is shorter than 50 bytes, declares a
 *   version other than 1, or declares an iteration count outside 1,000 to
 *   5,000,000 (checked before any key is derived); or if the decrypted bytes
 *   are not valid Deflate or decompress to more than 15,360 bytes
 * @throws AuthenticationError if AES-GCM rejects the Envelope: a wrong
 *   Password or any change to the Envelope
 */
export async function open(envelope: Uint8Array, password: string): Promise<Uint8Array<ArrayBuffer>> {
  if (envelope.length < MIN_ENVELOPE_BYTES) {
    throw new FormatError('envelope shorter than', MIN_ENVELOPE_BYTES, 'bytes')
  }
  if (envelope[0] !== VERSION) throw new FormatError('unsupported envelope version', envelope[0])
  const iterations = readUint32BE(envelope, OFFSET_ITERATIONS)
  if (!isValidIterations(iterations)) throw new FormatError('unsupported iteration count', iterations)
  // After the format checks, so a malformed Envelope gets FormatError whatever
  // the Password (Requirement 1.4); before deriving a key (Requirement 1.9).
  assertNoNullCharacter(password)

  // Web Crypto takes only views over an ArrayBuffer, so copy the public parts.
  const header = copy(envelope.subarray(0, HEADER_BYTES))
  const salt = header.subarray(OFFSET_SALT, OFFSET_SALT + SALT_BYTES)
  const iv = header.subarray(OFFSET_IV, OFFSET_IV + IV_BYTES)
  const sealed = copy(envelope.subarray(HEADER_BYTES))

  const key = await deriveKey(password, salt, iterations)
  let decrypted: Uint8Array<ArrayBuffer>
  try {
    decrypted = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: header, tagLength: TAG_BYTES * 8 },
        key,
        sealed,
      ),
    )
  } catch (error) {
    // A new error with no `cause`: the original stays out of reach.
    if (isOperationError(error)) throw new AuthenticationError()
    throw error
  }

  try {
    return await decompress(decrypted, MAX_PLAINTEXT_BYTES)
  } finally {
    zeroize(decrypted)
  }
}

/**
 * Derives a non-extractable AES-256-GCM key with PBKDF2-HMAC-SHA-256 from the
 * UTF-8 bytes of the NFC-normalized Password (Requirement 1.6). The encoded
 * Password bytes are zeroed before returning, on every path.
 */
async function deriveKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password.normalize('NFC'))
  try {
    const baseKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey'])
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    zeroize(passwordBytes)
  }
}

/**
 * Rejects a Password containing U+0000 (Requirements 1.5, 1.9). HMAC zero-pads
 * keys shorter than 64 bytes, so a Password that differs only by trailing
 * U+0000 characters would derive the same key. The error names no part of the
 * Password.
 */
function assertNoNullCharacter(password: string): void {
  if (password.includes('\u0000')) throw new InputError('password contains a null character')
}

function isValidIterations(iterations: number): boolean {
  return Number.isInteger(iterations) && iterations >= MIN_ITERATIONS && iterations <= MAX_ITERATIONS
}

function isOperationError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'OperationError'
}

/** Copies `bytes` into a new array backed by its own ArrayBuffer. */
function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length)
  out.set(bytes)
  return out
}
