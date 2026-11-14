// Pure rules behind Unlock, Reveal, and Clear (design.md, "Deck_UI";
// Requirements 7.12, 7.13, 7.23, 7.24, 7.27, 8.4). DOM-free.
//
// The recovered Plaintext stays a Uint8Array until the user selects Reveal;
// only then is it decoded to a string for display. The mask has a fixed
// length, so the masked form does not even reveal the secret's size.
// Nothing here logs, stores, or returns any part of the Plaintext or Password
// except `revealText`, whose result goes straight into the DOM.

import { BaudVaultError } from '../core/errors'
import { errorText } from './messages'
import { hasNullCharacter, NULL_CHARACTER_MESSAGE } from './record-rules'

/** Shown in place of the recovered secret until Reveal (Requirements 7.12, 9.8). */
export const SECRET_MASK = '••••••••••••'

export type UnlockReadiness = {
  /** Unlock may be selected. */
  ready: boolean
  /** Why Unlock is disabled, or null when it is enabled or the reason is obvious. */
  problem: string | null
}

/**
 * Whether Unlock is enabled: an Envelope is held, no seal or open is running
 * (Requirement 7.27), and the Unlock password is non-empty without U+0000, which the
 * Vault_Engine would reject (Requirement 1.9). `unavailable` is
 * `FeatureSupport.unlockProblem`: when the browser lacks a feature opening
 * needs, Unlock is disabled with that message, even before an Envelope is
 * held (Requirement 10.2).
 */
export function unlockReadiness(
  hasEnvelope: boolean,
  password: string,
  busy: boolean,
  unavailable: string | null = null,
): UnlockReadiness {
  if (unavailable !== null) return { ready: false, problem: unavailable }
  if (!hasEnvelope) return { ready: false, problem: null }
  if (hasNullCharacter(password)) return { ready: false, problem: NULL_CHARACTER_MESSAGE }
  if (password.length === 0) return { ready: false, problem: 'Enter the unlock password to unlock.' }
  return { ready: !busy, problem: null }
}

export type UnlockFailure = {
  message: string
  /** Clear the Unlock password field: only after an AuthenticationError (Requirement 7.24). */
  clearPassword: boolean
}

/**
 * How the UI reacts to a failed `open`. The held Envelope is always kept, so
 * the user can try another Password.
 */
export function unlockFailure(error: unknown): UnlockFailure {
  return {
    message: errorText(error),
    clearPassword: error instanceof BaudVaultError && error.code === 'AUTH',
  }
}

/** The recovered secret as text, for display after Reveal. Invalid UTF-8 becomes U+FFFD. */
export function revealText(plaintext: Uint8Array): string {
  return new TextDecoder().decode(plaintext)
}

/** Overwrites every recovered Plaintext array with zeros (Requirement 7.13). */
export function wipePlaintext(...arrays: readonly (Uint8Array | null)[]): void {
  for (const array of arrays) array?.fill(0)
}
