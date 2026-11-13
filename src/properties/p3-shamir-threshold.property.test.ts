// Property 3: Shamir threshold reconstruction (design.md, "Correctness Properties").
//
// For any Envelope, any 2 ≤ K ≤ N ≤ 16, and any subset of at least K of the
// N Shards in any order, `combine` returns the original Envelope. Any subset
// of K − 1 Shards throws ShardError.
//
// **Validates: Requirements 2.1, 2.2, 2.3**

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ShardError } from '../core/errors'
import { MAX_SHARDS, MIN_THRESHOLD, combine, parseShard, split } from '../shamir/shamir'

/** Largest Envelope: 15,360 bytes of incompressible Plaintext plus zlib framing and 49 bytes of overhead. */
const MAX_ENVELOPE_BYTES = 15_420

/**
 * Envelope bytes, biased toward small sizes. The Shard_Codec treats the
 * Envelope as opaque bytes, so random bytes stand in for a sealed Envelope
 * without paying for key derivation. Lengths start at 1 because `split`
 * rejects an empty Envelope.
 */
const envelopeArb = fc.oneof(
  { arbitrary: fc.uint8Array({ minLength: 1, maxLength: 64 }), weight: 6 },
  { arbitrary: fc.uint8Array({ minLength: 1, maxLength: 512 }), weight: 3 },
  { arbitrary: fc.uint8Array({ minLength: 1, maxLength: MAX_ENVELOPE_BYTES }), weight: 1 },
)

/** K and N with 2 ≤ K ≤ N ≤ 16. */
const thresholdArb = fc
  .integer({ min: MIN_THRESHOLD, max: MAX_SHARDS })
  .chain((n) => fc.record({ k: fc.integer({ min: MIN_THRESHOLD, max: n }), n: fc.constant(n) }))

/** K, N, and the positions (0 to N − 1) of a shuffled subset of at least K Shards. */
const enoughShardsArb = thresholdArb.chain(({ k, n }) =>
  fc.record({
    k: fc.constant(k),
    n: fc.constant(n),
    picked: fc.shuffledSubarray(positions(n), { minLength: k }),
  }),
)

/** K, N, and the positions of a shuffled subset of exactly K − 1 Shards. */
const tooFewShardsArb = thresholdArb.chain(({ k, n }) =>
  fc.record({
    k: fc.constant(k),
    n: fc.constant(n),
    picked: fc.shuffledSubarray(positions(n), { minLength: k - 1, maxLength: k - 1 }),
  }),
)

function positions(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

/** Requirement 2.1: N Shards sharing one set ID, K, and N, with distinct indices 1 to N. */
function expectWellFormedSet(shards: readonly Uint8Array[], envelope: Uint8Array, k: number, n: number): void {
  expect(shards).toHaveLength(n)
  const infos = shards.map(parseShard)
  const setId = infos[0]!.setId
  for (const [i, info] of infos.entries()) {
    expect(info.setId).toBe(setId)
    expect(info.k).toBe(k)
    expect(info.n).toBe(n)
    expect(info.index).toBe(i + 1)
    expect(info.data.length).toBe(envelope.length)
  }
}

describe('Property 3: Shamir threshold reconstruction', () => {
  it('rebuilds the Envelope from any subset of at least K Shards in any order', () => {
    fc.assert(
      fc.property(envelopeArb, enoughShardsArb, (envelope, { k, n, picked }) => {
        const shards = split(envelope, k, n)
        expectWellFormedSet(shards, envelope, k, n)

        const rebuilt = combine(picked.map((p) => shards[p]!))
        expect(rebuilt).toEqual(envelope)
      }),
      { numRuns: 200 },
    )
  })

  it('rejects any subset of K − 1 Shards with ShardError needing 1 more Shard', () => {
    fc.assert(
      fc.property(envelopeArb, tooFewShardsArb, (envelope, { k, n, picked }) => {
        const shards = split(envelope, k, n)
        expectWellFormedSet(shards, envelope, k, n)

        let thrown: unknown
        try {
          combine(picked.map((p) => shards[p]!))
        } catch (error) {
          thrown = error
        }
        expect(thrown).toBeInstanceOf(ShardError)
        const shardError = thrown as ShardError
        expect(shardError.reason).toBe('too-few')
        expect(shardError.missing).toBe(1)
      }),
      { numRuns: 200 },
    )
  })
})
