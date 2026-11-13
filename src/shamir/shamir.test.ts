import { describe, expect, it } from 'vitest'
import { FormatError, InputError, ShardError } from '../core/errors'
import { combine, MAX_SHARDS, MIN_THRESHOLD, parseShard, split } from './shamir'

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

function catchError(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

function expectShardError(run: () => unknown, reason: ShardError['reason']): ShardError {
  const error = catchError(run)
  expect(error).toBeInstanceOf(ShardError)
  expect((error as ShardError).reason).toBe(reason)
  return error as ShardError
}

/** A valid 8-byte header plus `m` data bytes, for building malformed Shards by hand. */
function rawShard(fields: { version?: number; k?: number; n?: number; index?: number; m?: number }): Uint8Array {
  const { version = 1, k = 2, n = 3, index = 1, m = 4 } = fields
  const shard = new Uint8Array(8 + m)
  shard[0] = version
  shard.set([0xde, 0xad, 0xbe, 0xef], 1)
  shard[5] = k
  shard[6] = n
  shard[7] = index
  return shard
}

describe('split', () => {
  it('writes the v1 Shard layout with one set ID and indices 1 to N (Requirement 2.1)', () => {
    const envelope = randomBytes(60)
    const shards = split(envelope, 3, 5)
    expect(shards.length).toBe(5)
    const setId = shards[0]!.subarray(1, 5)
    shards.forEach((shard, i) => {
      expect(shard.length).toBe(8 + 60)
      expect(shard[0]).toBe(1)
      expect(shard.subarray(1, 5)).toEqual(setId)
      expect(shard[5]).toBe(3)
      expect(shard[6]).toBe(5)
      expect(shard[7]).toBe(i + 1)
    })
  })

  it('draws a new set ID for each split', () => {
    const envelope = randomBytes(60)
    const a = parseShard(split(envelope, 2, 2)[0]!).setId
    const b = parseShard(split(envelope, 2, 2)[0]!).setId
    // Equal with probability 2^-32.
    expect(a).not.toBe(b)
  })

  it('does not copy the Envelope into any Shard', () => {
    const envelope = randomBytes(200)
    for (const shard of split(envelope, 2, 3)) expect(shard.subarray(8)).not.toEqual(envelope)
  })

  it.each([
    ['K < 2', 1, 3],
    ['K = 0', 0, 3],
    ['N < K', 3, 2],
    ['N > 16', 2, 17],
    ['non-integer K', 2.5, 3],
    ['non-integer N', 2, 3.5],
  ])('rejects %s with InputError (Requirement 2.5)', (_label, k, n) => {
    expect(() => split(randomBytes(10), k, n)).toThrow(InputError)
  })

  it('rejects an empty Envelope with InputError', () => {
    expect(() => split(new Uint8Array(0), 2, 3)).toThrow(InputError)
  })

  it('accepts the limits K = 2 and K = N = 16', () => {
    const envelope = randomBytes(50)
    expect(combine(split(envelope, MIN_THRESHOLD, MIN_THRESHOLD))).toEqual(envelope)
    expect(combine(split(envelope, MAX_SHARDS, MAX_SHARDS))).toEqual(envelope)
  })
})

describe('combine', () => {
  it.each([
    [2, 3],
    [3, 5],
    [5, 16],
  ])('rebuilds the Envelope from any %i of %i Shards (Requirement 2.2)', (k, n) => {
    const envelope = randomBytes(120)
    const shards = split(envelope, k, n)
    expect(combine(shards.slice(0, k))).toEqual(envelope)
    expect(combine(shards.slice(n - k))).toEqual(envelope)
    expect(combine([...shards].reverse())).toEqual(envelope)
  })

  it('rebuilds a one-byte Envelope', () => {
    const envelope = Uint8Array.of(0x42)
    expect(combine(split(envelope, 2, 2))).toEqual(envelope)
  })

  it('reports how many more Shards are needed (Requirement 2.3)', () => {
    const shards = split(randomBytes(60), 4, 6)
    expect(expectShardError(() => combine(shards.slice(0, 3)), 'too-few').missing).toBe(1)
    const error = expectShardError(() => combine(shards.slice(0, 1)), 'too-few')
    expect(error.missing).toBe(3)
    expect(error.message).toBe('need 3 more shards')
  })

  it('treats an empty list as too few', () => {
    expect(expectShardError(() => combine([]), 'too-few').missing).toBe(2)
  })

  it('rejects Shards from different sets (Requirement 2.4)', () => {
    const envelope = randomBytes(60)
    const a = split(envelope, 2, 3)
    const b = split(envelope, 2, 3)
    expectShardError(() => combine([a[0]!, b[1]!]), 'different-set')
  })

  it('rejects Shards that declare different K or N (Requirement 2.4)', () => {
    const shards = split(randomBytes(60), 2, 4)
    const otherK = shards[1]!.slice()
    otherK[5] = 3
    expectShardError(() => combine([shards[0]!, otherK]), 'different-threshold')
    const otherN = shards[1]!.slice()
    otherN[6] = 3
    expectShardError(() => combine([shards[0]!, otherN]), 'different-threshold')
  })

  it('rejects Shards of different lengths (Requirement 2.4)', () => {
    const shards = split(randomBytes(60), 2, 3)
    expectShardError(() => combine([shards[0]!, shards[1]!.subarray(0, 50)]), 'different-length')
  })

  it('rejects two Shards with the same index (Requirement 2.4)', () => {
    const shards = split(randomBytes(60), 2, 3)
    expectShardError(() => combine([shards[0]!, shards[0]!.slice()]), 'duplicate-index')
  })

  it('reports a duplicate index ahead of too few', () => {
    const shards = split(randomBytes(60), 3, 5)
    expectShardError(() => combine([shards[1]!, shards[1]!]), 'duplicate-index')
  })

  it.each([
    ['wrong version', { version: 2 }],
    ['version 0', { version: 0 }],
    ['K < 2', { k: 1, n: 3 }],
    ['K > N', { k: 4, n: 3 }],
    ['N > 16', { k: 2, n: 17 }],
    ['index 0', { index: 0 }],
    ['index > N', { index: 4 }],
    ['no data bytes', { m: 0 }],
  ])('rejects a Shard with %s with FormatError (Requirement 2.6)', (_label, fields) => {
    const bad = rawShard(fields)
    expect(() => parseShard(bad)).toThrow(FormatError)
    expect(() => combine([bad])).toThrow(FormatError)
  })

  it('rejects a Shard shorter than its header with FormatError', () => {
    expect(() => combine([new Uint8Array(5)])).toThrow(FormatError)
  })

  it('reports a malformed Shard ahead of set-consistency and count errors', () => {
    const a = split(randomBytes(60), 3, 5)
    const b = split(randomBytes(60), 3, 5)
    const bad = rawShard({ version: 9 })
    // Mixed sets, a duplicate, and too few Shards, but the malformed Shard comes last.
    expect(() => combine([a[0]!, b[0]!, a[0]!, bad])).toThrow(FormatError)
    expect(() => combine([a[0]!, bad])).toThrow(FormatError)
  })
})

describe('parseShard', () => {
  it('reads the header fields and a view of the data', () => {
    const shard = rawShard({ k: 3, n: 5, index: 5, m: 2 })
    shard[8] = 0xaa
    shard[9] = 0xbb
    const info = parseShard(shard)
    expect(info).toMatchObject({ setId: 0xdeadbeef, k: 3, n: 5, index: 5 })
    expect(info.data).toEqual(Uint8Array.of(0xaa, 0xbb))
  })
})
