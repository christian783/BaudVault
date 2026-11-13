// Shard_Codec: Shamir Secret Sharing over GF(256) (design.md, "Shard_Codec"
// and "Shard v1").
//
// `split` runs on the Envelope (ciphertext), never on the Plaintext. For each
// Envelope byte s it picks a random polynomial f(x) = s + a1·x + … + a(K−1)·x^(K−1)
// and gives Shard x the value f(x). `combine` interpolates at x = 0.
//
// The set ID and every coefficient come only from `crypto.getRandomValues`
// (Requirement 8.5). Coefficients are zeroed once the Shards are built.
// Error messages carry fixed text and header numbers only (Requirement 8.9).

import { readUint32BE } from '../core/bytes'
import { FormatError, InputError, ShardError } from '../core/errors'
import { div, mul } from '../gf256/gf256'

/** Largest N accepted by `split` and in a Shard header. */
export const MAX_SHARDS = 16
/** Smallest K accepted by `split` and in a Shard header. */
export const MIN_THRESHOLD = 2

const VERSION = 0x01
const OFFSET_SET_ID = 1
const OFFSET_K = 5
const OFFSET_N = 6
const OFFSET_INDEX = 7
/** Bytes 0 to 7: version, set ID, K, N, index. */
const HEADER_BYTES = 8
/** `crypto.getRandomValues` fills at most 65,536 bytes per call. */
const RANDOM_CHUNK_BYTES = 65_536

/** The parsed header of a Shard v1, plus a view of its data bytes. */
export type ShardInfo = {
  /** Random 4-byte set ID shared by every Shard of one split, as an unsigned integer. */
  setId: number
  k: number
  n: number
  /** The x coordinate, 1 to N. */
  index: number
  /** The m bytes f(x), one per Envelope byte. A view into the Shard, not a copy. */
  data: Uint8Array
}

/**
 * Splits `envelope` into `n` encoded Shards, any `k` of which rebuild it.
 * Shard `i` (index i, 1 ≤ i ≤ n) is element `i − 1` of the result.
 *
 * @throws InputError if `envelope` is empty, `k` or `n` is not an integer,
 *   `k` < 2, `n` < `k`, or `n` > 16
 */
export function split(envelope: Uint8Array, k: number, n: number): Uint8Array<ArrayBuffer>[] {
  if (envelope.length === 0) throw new InputError('envelope must not be empty')
  if (!Number.isInteger(k) || !Number.isInteger(n)) throw new InputError('K and N must be integers')
  if (k < MIN_THRESHOLD) throw new InputError('K must be at least', MIN_THRESHOLD)
  if (n < k) throw new InputError('N must be at least K')
  if (n > MAX_SHARDS) throw new InputError('N must be at most', MAX_SHARDS)

  const m = envelope.length
  const degree = k - 1
  const setId = new Uint8Array(4)
  crypto.getRandomValues(setId)

  const shards: Uint8Array<ArrayBuffer>[] = []
  for (let x = 1; x <= n; x++) {
    const shard = new Uint8Array(HEADER_BYTES + m)
    shard[0] = VERSION
    shard.set(setId, OFFSET_SET_ID)
    shard[OFFSET_K] = k
    shard[OFFSET_N] = n
    shard[OFFSET_INDEX] = x
    shards.push(shard)
  }

  // coeffs[j·degree + (d − 1)] is a_d for Envelope byte j.
  const coeffs = new Uint8Array(m * degree)
  try {
    fillRandom(coeffs)
    for (let j = 0; j < m; j++) {
      const base = j * degree
      const secret = envelope[j]!
      for (let x = 1; x <= n; x++) {
        // Horner's rule, highest degree first: a(K−1), …, a1, then s.
        let y = 0
        for (let d = degree; d >= 1; d--) y = mul(y, x) ^ coeffs[base + d - 1]!
        y = mul(y, x) ^ secret
        shards[x - 1]![HEADER_BYTES + j] = y
      }
    }
  } finally {
    coeffs.fill(0)
  }
  return shards
}

/**
 * Rebuilds the Envelope from encoded Shards. Validation runs in three stages
 * and stops at the first failure:
 *
 * 1. Layout: every Shard must match the v1 layout (`FormatError`).
 * 2. Set consistency: all Shards must share set ID, K, N, and length, and no
 *    two may share an index (`ShardError`).
 * 3. Count: at least K Shards are needed (`ShardError` with `missing`).
 *
 * An empty array throws `ShardError('too-few', 2)`: with no Shard there is no
 * K to read, and 2 is the smallest K any set can have.
 *
 * Shards beyond K are accepted and ignored; the K with the lowest indices are used.
 *
 * @throws FormatError, ShardError as described above
 */
export function combine(shards: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  // Stage 1: layout, for every Shard before anything else.
  const parsed = shards.map(parseShard)

  if (parsed.length === 0) throw new ShardError('too-few', MIN_THRESHOLD)

  // Stage 2: set consistency.
  const first = parsed[0]!
  for (const shard of parsed) {
    if (shard.setId !== first.setId) throw new ShardError('different-set')
    if (shard.k !== first.k || shard.n !== first.n) throw new ShardError('different-threshold')
    if (shard.data.length !== first.data.length) throw new ShardError('different-length')
  }
  const seen = new Set<number>()
  for (const shard of parsed) {
    if (seen.has(shard.index)) throw new ShardError('duplicate-index')
    seen.add(shard.index)
  }

  // Stage 3: count.
  const k = first.k
  if (parsed.length < k) throw new ShardError('too-few', k - parsed.length)

  const used = [...parsed].sort((a, b) => a.index - b.index).slice(0, k)

  // Lagrange basis at x = 0: w_i = Π_{j≠i} x_j / (x_j − x_i). Subtraction is XOR.
  const weights = used.map((shard, i) => {
    let w = 1
    for (let j = 0; j < k; j++) {
      if (j === i) continue
      const xj = used[j]!.index
      w = mul(w, div(xj, xj ^ shard.index))
    }
    return w
  })

  const m = first.data.length
  const envelope = new Uint8Array(m)
  for (let i = 0; i < k; i++) {
    const w = weights[i]!
    const data = used[i]!.data
    for (let p = 0; p < m; p++) envelope[p]! ^= mul(w, data[p]!)
  }
  return envelope
}

/**
 * Parses and validates the header of one encoded Shard against the v1 layout:
 * version 1, 2 ≤ K ≤ N ≤ 16, 1 ≤ index ≤ N, and at least one data byte.
 *
 * @throws FormatError naming the first property that fails
 */
export function parseShard(shard: Uint8Array): ShardInfo {
  if (shard.length < HEADER_BYTES + 1) {
    throw new FormatError('shard too short', shard.length, 'bytes')
  }
  const version = shard[0]!
  if (version !== VERSION) throw new FormatError('unsupported shard version', version)
  const k = shard[OFFSET_K]!
  const n = shard[OFFSET_N]!
  if (k < MIN_THRESHOLD || n < k || n > MAX_SHARDS) {
    throw new FormatError('shard K and N out of range')
  }
  const index = shard[OFFSET_INDEX]!
  if (index < 1 || index > n) throw new FormatError('shard index out of range', index)
  return {
    setId: readUint32BE(shard, OFFSET_SET_ID),
    k,
    n,
    index,
    data: shard.subarray(HEADER_BYTES),
  }
}

/** Fills `bytes` from `crypto.getRandomValues`, in chunks within its per-call limit. */
function fillRandom(bytes: Uint8Array<ArrayBuffer>): void {
  for (let offset = 0; offset < bytes.length; offset += RANDOM_CHUNK_BYTES) {
    crypto.getRandomValues(bytes.subarray(offset, offset + RANDOM_CHUNK_BYTES))
  }
}
