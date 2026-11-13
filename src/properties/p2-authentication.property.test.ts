// Property 2: Authentication rejects every change (design.md, "Correctness Properties").
//
// For any sealed Envelope, opening with any different Password without U+0000
// (different after NFC normalization) throws AuthenticationError. Flipping any single bit of the
// Envelope makes `open` throw FormatError if the flip lands in the version
// byte or moves the iteration count outside 1,000 to 5,000,000, and
// AuthenticationError otherwise. No case returns Plaintext.
//
// **Validates: Requirements 1.3, 1.4**

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { readUint32BE } from '../core/bytes'
import { AuthenticationError, FormatError } from '../core/errors'
import { MAX_ITERATIONS, MAX_PLAINTEXT_BYTES, MIN_ITERATIONS, open, seal } from '../crypto/vault'

/** Test-only iteration count stored in the Envelope (design.md, "Testing Strategy"). */
const TEST_ITERATIONS = 1_000

/** Envelope offsets (design.md, "Envelope v1"). */
const OFFSET_VERSION = 0
const OFFSET_ITERATIONS = 1
const ITERATION_BYTES = 4

/**
 * A flip of bit 22 of the iteration count gives about 4.2 million iterations,
 * which takes about 2.5 seconds. The timeout leaves room for several such cases.
 */
const TIMEOUT_MS = 60_000

/**
 * Plaintext of 1 to 15,360 bytes, biased toward small sizes. Small Plaintexts
 * give short Envelopes, so the header bits (version and iteration count) are
 * hit in a natural share of the bit-flip runs.
 */
const plaintextArb = fc.oneof(
  { arbitrary: fc.uint8Array({ minLength: 1, maxLength: 256 }), weight: 6 },
  { arbitrary: fc.uint8Array({ minLength: 1, maxLength: MAX_PLAINTEXT_BYTES }), weight: 3 },
  { arbitrary: fc.uint8Array({ minLength: MAX_PLAINTEXT_BYTES, maxLength: MAX_PLAINTEXT_BYTES }), weight: 1 },
)

/**
 * Non-empty Passwords without U+0000, which the Vault_Engine rejects with
 * InputError (Requirements 1.5, 1.9); unit tests in `vault.test.ts` cover that.
 */
const passwordArb = fc
  .string({ unit: 'binary', minLength: 1, maxLength: 64 })
  .filter((s) => !s.includes('\u0000'))

/**
 * A sealing Password and a different opening Password. Half the pairs are
 * independent strings; the other half extend the sealing Password by a suffix,
 * a near miss. Pairs equal after NFC normalization are excluded, since those
 * are the same Password (Requirement 1.6).
 */
const passwordPairArb = fc
  .tuple(passwordArb, passwordArb, fc.boolean())
  .map(([sealing, other, extend]) => ({ sealing, opening: extend ? sealing + other : other }))
  .filter(({ sealing, opening }) => sealing.normalize('NFC') !== opening.normalize('NFC'))

/**
 * Awaits `open` and returns what it threw. If it resolves, the returned bytes
 * are zeroed and the test fails: no case may return Plaintext.
 */
async function rejectionOf(opening: Promise<Uint8Array>): Promise<unknown> {
  let opened: Uint8Array
  try {
    opened = await opening
  } catch (error) {
    return error
  }
  opened.fill(0)
  expect.fail('open returned Plaintext for a changed Envelope or Password')
}

/** The error class `open` must throw after flipping `bit` of `byteIndex` in `flipped`. */
function expectedErrorFor(flipped: Uint8Array, byteIndex: number): typeof FormatError | typeof AuthenticationError {
  if (byteIndex === OFFSET_VERSION) return FormatError
  if (byteIndex >= OFFSET_ITERATIONS && byteIndex < OFFSET_ITERATIONS + ITERATION_BYTES) {
    const iterations = readUint32BE(flipped, OFFSET_ITERATIONS)
    return iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS ? FormatError : AuthenticationError
  }
  return AuthenticationError
}

describe('Property 2: authentication rejects every change', () => {
  it(
    'rejects a different Password with AuthenticationError',
    async () => {
      await fc.assert(
        fc.asyncProperty(plaintextArb, passwordPairArb, async (plaintext, { sealing, opening }) => {
          const envelope = await seal(plaintext, sealing, { iterations: TEST_ITERATIONS })

          const error = await rejectionOf(open(envelope, opening))
          expect(error).toBeInstanceOf(AuthenticationError)
        }),
        { numRuns: 200 },
      )
    },
    TIMEOUT_MS,
  )

  it(
    'rejects any single-bit flip with FormatError or AuthenticationError as the flipped field dictates',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          plaintextArb,
          passwordArb,
          // Unbiased, so header bits get their natural share of runs. fast-check
          // otherwise favours small values, which overweights the slow
          // iteration-count flips (one at bit 22 costs about 2.5 seconds).
          fc.noBias(fc.nat({ max: 0x7fff_ffff })),
          async (plaintext, password, bitSeed) => {
            const envelope = await seal(plaintext, password, { iterations: TEST_ITERATIONS })

            // Every bit of the Envelope is in the domain, header included.
            const bitIndex = bitSeed % (envelope.length * 8)
            const byteIndex = bitIndex >>> 3
            const flipped = envelope.slice()
            flipped[byteIndex]! ^= 1 << (bitIndex & 7)

            const expected = expectedErrorFor(flipped, byteIndex)
            const error = await rejectionOf(open(flipped, password))
            expect(error).toBeInstanceOf(expected)
          },
        ),
        { numRuns: 200 },
      )
    },
    TIMEOUT_MS,
  )
})
