// Pure rules behind the Record panel (design.md, "Password warning";
// Requirements 1.5, 1.9, 7.25, 7.26). DOM-free so they can be unit tested.
//
// The short-password rule lives in the UI only: the Vault_Engine accepts any
// non-empty Password without U+0000. Length never disables Lock. An empty
// Password, a Password containing U+0000, or a secret outside 1 to 15,360
// UTF-8 bytes does, because the Vault_Engine would reject it with InputError.
//
// Nothing here stores, logs, or returns any part of the secret or Password;
// results are counts, flags, and fixed messages.

import { MAX_PLAINTEXT_BYTES } from '../crypto/vault'

/** Passwords with fewer Unicode code points than this, after NFC, get the warning. */
export const SHORT_PASSWORD_CODE_POINTS = 12

export const SHORT_PASSWORD_WARNING = 'A short password can be guessed offline by anyone who records the tape.'

/** Shown when a pasted Password contains U+0000, which the Vault_Engine rejects. */
export const NULL_CHARACTER_MESSAGE =
  'The password contains a null character (U+0000), which BaudVault cannot use.'

/** Code points in the NFC form of `password`: `[...password.normalize('NFC')].length`. */
export function passwordCodePoints(password: string): number {
  return [...password.normalize('NFC')].length
}

/** True while the Password has fewer than 12 code points after NFC (Requirement 7.25). */
export function isShortPassword(password: string): boolean {
  return passwordCodePoints(password) < SHORT_PASSWORD_CODE_POINTS
}

export function hasNullCharacter(password: string): boolean {
  return password.includes('\u0000')
}

/**
 * Bytes `new TextEncoder().encode(text)` would produce, counted without
 * making a copy of the text. A lone surrogate counts 3 bytes, the size of the
 * U+FFFD that TextEncoder writes in its place.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0)!
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
  }
  return bytes
}

export type LockReadiness = {
  /** Lock may be selected. */
  ready: boolean
  /** UTF-8 length of the secret. */
  secretBytes: number
  /** A message for an input the Vault_Engine would reject, or null. Empty fields give null. */
  problem: string | null
}

/**
 * Whether Lock is enabled for these inputs. Password length never matters
 * here (Requirement 7.26); only emptiness and U+0000 do. `unavailable` is
 * `FeatureSupport.lockProblem`: when the browser lacks a feature sealing
 * needs, Lock is disabled with that message (Requirement 10.2).
 */
export function lockReadiness(secret: string, password: string, unavailable: string | null = null): LockReadiness {
  const secretBytes = utf8ByteLength(secret)
  if (unavailable !== null) return { ready: false, secretBytes, problem: unavailable }
  const secretTooLong = secretBytes > MAX_PLAINTEXT_BYTES
  const nullCharacter = hasNullCharacter(password)
  let problem: string | null = null
  if (secretTooLong) {
    problem = `The secret is ${secretBytes.toLocaleString('en-US')} bytes; the limit is ${MAX_PLAINTEXT_BYTES.toLocaleString('en-US')} bytes.`
  } else if (nullCharacter) {
    problem = NULL_CHARACTER_MESSAGE
  }
  const ready = secretBytes >= 1 && !secretTooLong && password.length > 0 && !nullCharacter
  return { ready, secretBytes, problem }
}
