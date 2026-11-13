// Property 1: Seal and open round trip (design.md, "Correctness Properties").
//
// For any Plaintext of 1 to 15,360 bytes and any non-empty Password without
// U+0000 (rejected with InputError, Requirements 1.5 and 1.9), opening
// the sealed Envelope with the same Password returns the original Plaintext,
// and opening it with the NFD-normalized form of the Password returns the same
// result.
//
// **Validates: Requirements 1.1, 1.2, 1.6**

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MAX_PLAINTEXT_BYTES, open, seal } from '../crypto/vault'

/** Test-only iteration count stored in the Envelope (design.md, "Testing Strategy"). */
const TEST_ITERATIONS = 1_000

/** Plaintext of 1 to 15,360 bytes, biased toward small sizes but able to reach the limit. */
const plaintextArb = fc.oneof(
  { arbitrary: fc.uint8Array({ minLength: 1, maxLength: 256 }), weight: 6 },
  { arbitrary: fc.uint8Array({ minLength: 1, maxLength: MAX_PLAINTEXT_BYTES }), weight: 3 },
  { arbitrary: fc.uint8Array({ minLength: MAX_PLAINTEXT_BYTES, maxLength: MAX_PLAINTEXT_BYTES }), weight: 1 },
)

/** Precomposed characters whose NFD form differs from their NFC form. */
const precomposedCharArb = fc.constantFrom('é', 'Å', 'ñ', 'ü', 'ǖ', 'ệ', '가', '힣', 'Ω', 'ö')

/**
 * Non-empty Passwords. The binary-unit strings include characters outside the
 * Basic Multilingual Plane and combining marks; the mixed branch guarantees
 * precomposed characters so that the NFD Password differs from the original.
 */
const passwordArb = fc.oneof(
  { arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 64 }), weight: 3 },
  {
    arbitrary: fc
      .array(
        fc.oneof(
          { arbitrary: precomposedCharArb, weight: 2 },
          { arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }), weight: 1 },
        ),
        { minLength: 1, maxLength: 32 },
      )
      .map((chars) => chars.join('')),
    weight: 1,
  },
).filter((s) => !s.includes('\u0000'))

describe('Property 1: seal and open round trip', () => {
  it(
    'opens with the sealing Password and with its NFD form',
    async () => {
      await fc.assert(
        fc.asyncProperty(plaintextArb, passwordArb, async (plaintext, password) => {
          // Keep a copy so the comparison does not depend on seal leaving its input intact.
          const expected = plaintext.slice()
          const envelope = await seal(plaintext, password, { iterations: TEST_ITERATIONS })

          const opened = await open(envelope, password)
          expect(opened).toEqual(expected)

          const openedNfd = await open(envelope, password.normalize('NFD'))
          expect(openedNfd).toEqual(expected)
        }),
        { numRuns: 200 },
      )
    },
    30_000,
  )
})
