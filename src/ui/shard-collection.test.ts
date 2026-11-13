import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FormatError, ShardError } from '../core/errors'
import { open, seal } from '../crypto/vault'
import { split } from '../shamir/shamir'
import {
  collectBody,
  EMPTY_COLLECTION,
  formatSetId,
  pendingShardSets,
  type ShardCollection,
  shardProgressText,
} from './shard-collection'

const ENVELOPE = new Uint8Array(80).map((_, i) => (i * 29 + 3) & 0xff)

function addShards(start: ShardCollection, shards: readonly Uint8Array[]): ShardCollection {
  let collection = start
  for (const shard of shards) collection = collectBody(collection, 'shard', shard, 'test').collection
  return collection
}

describe('collectBody', () => {
  it('holds a decoded Envelope directly', () => {
    const { collection, outcome } = collectBody(EMPTY_COLLECTION, 'envelope', ENVELOPE, 'tape.wav')
    expect(outcome.kind).toBe('held')
    expect(collection.held).toEqual({ envelope: ENVELOPE, origin: 'vault tape from tape.wav' })
  })

  it('shows "n of K" until K distinct Shards arrive, then rebuilds the Envelope (Requirements 7.9, 7.23)', () => {
    const shards = split(ENVELOPE, 3, 5)
    let collection = addShards(EMPTY_COLLECTION, [shards[4]!])
    const [pending] = pendingShardSets(collection)
    expect(pending).toMatchObject({ have: 1, k: 3 })
    expect(shardProgressText(pending!)).toBe(`Set ${formatSetId(pending!.setId)}: 1 of 3 shards needed`)

    // The same tape decoded again adds nothing.
    const again = collectBody(collection, 'shard', shards[4]!, 'test')
    expect(again.outcome.kind).toBe('duplicate')
    expect(again.collection).toBe(collection)

    collection = addShards(collection, [shards[1]!])
    expect(pendingShardSets(collection)[0]).toMatchObject({ have: 2, k: 3 })
    expect(collection.held).toBeNull()

    const last = collectBody(collection, 'shard', shards[0]!, 'test')
    expect(last.outcome).toEqual({ kind: 'rebuilt', shardCount: 3 })
    expect(last.collection.held?.envelope).toEqual(ENVELOPE)
    expect(pendingShardSets(last.collection)).toEqual([])
  })

  it('groups Shards by set ID', () => {
    const a = split(ENVELOPE, 2, 3)
    const b = split(ENVELOPE, 3, 5)
    const collection = addShards(EMPTY_COLLECTION, [a[0]!, b[0]!, b[1]!])
    expect(pendingShardSets(collection).map(({ have, k }) => [have, k])).toEqual([
      [1, 2],
      [2, 3],
    ])
    expect(addShards(collection, [a[2]!]).held?.envelope).toEqual(ENVELOPE)
  })

  it('rejects a malformed or inconsistent Shard and keeps what it had (Requirement 7.28)', () => {
    const shards = split(ENVELOPE, 2, 3)
    const collection = addShards(EMPTY_COLLECTION, [shards[0]!])

    const malformed = Uint8Array.from(shards[1]!)
    malformed[0] = 2
    const bad = collectBody(collection, 'shard', malformed, 'test')
    expect(bad.outcome.kind === 'failed' && bad.outcome.error).toBeInstanceOf(FormatError)
    expect(bad.collection).toBe(collection)

    const shorter = shards[1]!.subarray(0, shards[1]!.length - 1)
    const short = collectBody(collection, 'shard', shorter, 'test')
    expect(short.outcome.kind === 'failed' && short.outcome.error).toBeInstanceOf(ShardError)
    expect(short.collection).toBe(collection)

    // The genuine Shard still completes the set.
    expect(addShards(collection, [shards[1]!]).held?.envelope).toEqual(ENVELOPE)
  })
})

describe('collectBody with Shards from several sets (Requirement 7.9)', () => {
  it('groups interleaved Shards of three sets and rebuilds each set to its own Envelope', () => {
    const envelopes = [ENVELOPE, ENVELOPE.map((b) => b ^ 0x5a), ENVELOPE.subarray(0, 40)]
    const [a, b, c] = [split(envelopes[0]!, 2, 3), split(envelopes[1]!, 3, 5), split(envelopes[2]!, 4, 4)]
    const progress = (collection: ShardCollection) => pendingShardSets(collection).map(({ have, k }) => `${have}/${k}`)

    let collection = addShards(EMPTY_COLLECTION, [b[3]!, c[0]!, a[1]!, c[2]!, b[0]!])
    expect(progress(collection)).toEqual(['2/3', '2/4', '1/2'])
    expect(collection.held).toBeNull()

    let step = collectBody(collection, 'shard', c[3]!, 'test')
    expect(step.outcome.kind).toBe('shard-added')
    collection = step.collection
    expect(progress(collection)).toEqual(['2/3', '3/4', '1/2'])

    step = collectBody(collection, 'shard', a[2]!, 'test')
    expect(step.outcome).toEqual({ kind: 'rebuilt', shardCount: 2 })
    expect(step.collection.held?.envelope).toEqual(envelopes[0])
    collection = step.collection
    expect(progress(collection)).toEqual(['2/3', '3/4'])

    collection = addShards(collection, [c[1]!])
    expect(collection.held?.envelope).toEqual(envelopes[2])
    collection = addShards(collection, [b[4]!])
    expect(collection.held?.envelope).toEqual(envelopes[1])
    expect(pendingShardSets(collection)).toEqual([])
    expect(collection.groups.map((group) => group.combined)).toEqual([true, true, true])
  })

  it('ignores a duplicate or extra Shard of a set that is already rebuilt', () => {
    const shards = split(ENVELOPE, 2, 4)
    const other = Uint8Array.from(ENVELOPE).reverse()
    let collection = addShards(EMPTY_COLLECTION, [shards[0]!, shards[1]!])
    collection = collectBody(collection, 'envelope', other, 'tape.wav').collection

    const duplicate = collectBody(collection, 'shard', shards[1]!, 'test')
    expect(duplicate.outcome.kind).toBe('duplicate')
    expect(duplicate.collection).toBe(collection)

    // A third Shard is stored, but neither rebuilds again nor replaces the held Envelope.
    const extra = collectBody(collection, 'shard', shards[3]!, 'test')
    expect(extra.outcome.kind).toBe('shard-added')
    expect(extra.collection.held?.envelope).toEqual(other)
    expect(extra.collection.groups[0]!.indices).toEqual([1, 2, 4])
    expect(pendingShardSets(extra.collection)).toEqual([])
  })

  it('keeps the held Envelope and every group when a Shard is rejected (Requirement 7.28)', () => {
    const a = split(ENVELOPE, 2, 3)
    const b = split(ENVELOPE.subarray(0, 50), 3, 5)
    const collection = addShards(EMPTY_COLLECTION, [a[0]!, b[0]!, a[2]!])
    expect(collection.held?.envelope).toEqual(ENVELOPE)

    // Same set ID as `b`, but K changed from 3 to 2: a valid layout that disagrees with its group.
    const otherK = Uint8Array.from(b[1]!)
    otherK[5] = 2
    // Index 0 breaks the v1 layout.
    const badIndex = Uint8Array.from(b[1]!)
    badIndex[7] = 0
    for (const [shard, type] of [
      [otherK, ShardError],
      [badIndex, FormatError],
    ] as const) {
      const result = collectBody(collection, 'shard', shard, 'test')
      expect(result.outcome.kind === 'failed' && result.outcome.error).toBeInstanceOf(type)
      expect(result.collection).toBe(collection)
    }
    expect(otherK.length).toBe(b[1]!.length)

    // A decoded Envelope replaces the held one but leaves pending sets alone.
    const envelope = collectBody(collection, 'envelope', ENVELOPE.subarray(0, 60), 'tape.wav').collection
    expect(envelope.groups).toBe(collection.groups)
    expect(pendingShardSets(envelope)).toEqual(pendingShardSets(collection))
  })

  it('rebuilds a real sealed Envelope from interleaved Shards and opens it', async () => {
    const plaintext = new TextEncoder().encode('correct horse battery staple')
    const sealed = await seal(plaintext, 'pw', { iterations: 1_000 })
    const shards = split(sealed, 2, 3)
    const decoy = split(sealed.map((b) => b ^ 0xff), 2, 3)

    const collection = addShards(EMPTY_COLLECTION, [shards[2]!, decoy[0]!, shards[0]!])
    expect(pendingShardSets(collection).map(({ have, k }) => [have, k])).toEqual([[1, 2]])
    expect(collection.held?.envelope).toEqual(sealed)
    expect(await open(collection.held!.envelope, 'pw')).toEqual(plaintext)
  })

  it('property: any interleaving of several sets, with repeats, tracks progress and rebuilds each set', () => {
    const setArb = fc
      .integer({ min: 2, max: 5 })
      .chain((n) =>
        fc.record({ k: fc.integer({ min: 2, max: n }), n: fc.constant(n), envelope: fc.uint8Array({ minLength: 1, maxLength: 32 }) }),
      )
    const scenarioArb = fc.array(setArb, { minLength: 2, maxLength: 3 }).chain((sets) => {
      // Every Shard of every set once, plus up to 4 repeats, in any order.
      const all = sets.flatMap(({ n }, set) => Array.from({ length: n }, (_, i) => ({ set, i })))
      return fc.record({
        sets: fc.constant(sets),
        order: fc.tuple(fc.shuffledSubarray(all, { minLength: all.length }), fc.array(fc.constantFrom(...all), { maxLength: 4 })).chain(
          ([perm, repeats]) => fc.shuffledSubarray([...perm, ...repeats], { minLength: perm.length + repeats.length }),
        ),
      })
    })

    fc.assert(
      fc.property(scenarioArb, ({ sets, order }) => {
        const shards = sets.map(({ envelope, k, n }) => split(envelope, k, n))
        const seen = sets.map(() => new Set<number>())
        const firstSeen: number[] = []
        let lastRebuilt: number | null = null
        let collection = EMPTY_COLLECTION

        for (const { set, i } of order) {
          const { collection: next, outcome } = collectBody(collection, 'shard', shards[set]![i]!, 'test')
          const before = seen[set]!.size
          if (seen[set]!.has(i)) {
            expect(outcome.kind).toBe('duplicate')
            expect(next).toBe(collection)
          } else {
            seen[set]!.add(i)
            if (before === 0) firstSeen.push(set)
            if (seen[set]!.size === sets[set]!.k) {
              expect(outcome).toEqual({ kind: 'rebuilt', shardCount: sets[set]!.k })
              lastRebuilt = set
            } else {
              expect(outcome.kind).toBe('shard-added')
            }
          }
          collection = next

          // "n of K" shows only for sets with 1 ≤ distinct < K, in first-seen order.
          const expected = firstSeen
            .filter((s) => seen[s]!.size < sets[s]!.k)
            .map((s) => ({ have: seen[s]!.size, k: sets[s]!.k }))
          expect(pendingShardSets(collection).map(({ have, k }) => ({ have, k }))).toEqual(expected)
          if (lastRebuilt === null) expect(collection.held).toBeNull()
          else expect(collection.held?.envelope).toEqual(sets[lastRebuilt]!.envelope)
        }
        expect(collection.groups).toHaveLength(sets.length)
      }),
      { numRuns: 100 },
    )
  })
})

describe('formatSetId', () => {
  it('writes eight upper-case hex digits', () => {
    expect(formatSetId(0x1a2b)).toBe('00001A2B')
    expect(formatSetId(0xffffffff)).toBe('FFFFFFFF')
  })
})
