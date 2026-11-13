import { describe, expect, it } from 'vitest'
import { UncorrectableError } from '../core/errors'
import { EXP, polyEval } from '../gf256/gf256'
import { MAX_DATA_BYTES, PARITY_BYTES, rsDecode, rsEncode } from './reed-solomon'

/**
 * Seeded mulberry32, so damage patterns are the same on every run. Test data
 * only; never a security value.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function randomData(next: () => number, length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(next() * 256)
  return bytes
}

/** Returns a copy of `codeword` with `count` distinct positions XORed by random non-zero masks. */
function damage(next: () => number, codeword: Uint8Array, count: number): Uint8Array<ArrayBuffer> {
  const out = codeword.slice()
  const positions = new Set<number>()
  while (positions.size < count) positions.add(Math.floor(next() * codeword.length))
  for (const p of positions) out[p]! ^= 1 + Math.floor(next() * 255)
  return out
}

describe('rsEncode', () => {
  it('is systematic: data first, then 32 parity bytes', () => {
    const data = randomData(seededRandom(1), MAX_DATA_BYTES)
    const codeword = rsEncode(data)
    expect(codeword.length).toBe(255)
    expect(codeword.subarray(0, MAX_DATA_BYTES)).toEqual(data)
  })

  it('produces codewords with alpha^0 to alpha^31 as roots', () => {
    const next = seededRandom(2)
    for (const length of [1, 16, 100, MAX_DATA_BYTES]) {
      const codeword = rsEncode(randomData(next, length))
      for (let i = 0; i < PARITY_BYTES; i++) expect(polyEval(codeword, EXP[i]!)).toBe(0)
    }
  })

  it('encodes all-zero data to an all-zero codeword', () => {
    expect(rsEncode(new Uint8Array(MAX_DATA_BYTES))).toEqual(new Uint8Array(255))
  })

  it('makes a shortened codeword equal the tail of the zero-prefixed full codeword', () => {
    const data = randomData(seededRandom(3), 16)
    const full = new Uint8Array(MAX_DATA_BYTES)
    full.set(data, MAX_DATA_BYTES - 16)
    expect(rsEncode(data)).toEqual(rsEncode(full).subarray(255 - 48))
  })

  it('rejects empty and oversize data with RangeError', () => {
    expect(() => rsEncode(new Uint8Array(0))).toThrow(RangeError)
    expect(() => rsEncode(new Uint8Array(MAX_DATA_BYTES + 1))).toThrow(RangeError)
  })
})

describe('rsDecode', () => {
  it('returns corrected 0 for a clean codeword', () => {
    const data = randomData(seededRandom(4), MAX_DATA_BYTES)
    const result = rsDecode(rsEncode(data))
    expect(result.corrected).toBe(0)
    expect(result.data).toEqual(data)
  })

  it.each([
    ['full 255-byte', MAX_DATA_BYTES],
    ['shortened 48-byte', 16],
  ])('corrects exactly 16 errors in a %s codeword (Requirement 3.3)', (_label, length) => {
    const next = seededRandom(5 + length)
    for (let trial = 0; trial < 20; trial++) {
      const data = randomData(next, length)
      const damaged = damage(next, rsEncode(data), 16)
      const result = rsDecode(damaged)
      expect(result.corrected).toBe(16)
      expect(result.data).toEqual(data)
    }
  })

  it.each([1, 5, 15])('reports the count when %i bytes are damaged', (count) => {
    const next = seededRandom(100 + count)
    const data = randomData(next, MAX_DATA_BYTES)
    const result = rsDecode(damage(next, rsEncode(data), count))
    expect(result.corrected).toBe(count)
    expect(result.data).toEqual(data)
  })

  it('corrects errors in the parity bytes', () => {
    const data = randomData(seededRandom(6), MAX_DATA_BYTES)
    const codeword = rsEncode(data)
    for (let p = 255 - 16; p < 255; p++) codeword[p]! ^= 0xa5
    const result = rsDecode(codeword)
    expect(result.corrected).toBe(16)
    expect(result.data).toEqual(data)
  })

  it.each([
    ['full 255-byte', MAX_DATA_BYTES],
    ['shortened 48-byte', 16],
  ])('rejects 17 errors in a %s codeword with UncorrectableError', (_label, length) => {
    const next = seededRandom(7 + length)
    for (let trial = 0; trial < 20; trial++) {
      const data = randomData(next, length)
      const damaged = damage(next, rsEncode(data), 17)
      expect(() => rsDecode(damaged)).toThrow(UncorrectableError)
    }
  })

  it('throws an UncorrectableError with no block indices', () => {
    const next = seededRandom(8)
    const damaged = damage(next, rsEncode(randomData(next, MAX_DATA_BYTES)), 17)
    let error: unknown
    try {
      rsDecode(damaged)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(UncorrectableError)
    expect((error as UncorrectableError).blocks).toEqual([])
  })

  it('does not modify its input', () => {
    const next = seededRandom(9)
    const damaged = damage(next, rsEncode(randomData(next, MAX_DATA_BYTES)), 10)
    const before = damaged.slice()
    rsDecode(damaged)
    expect(damaged).toEqual(before)
  })

  it('rejects lengths outside 33 to 255 with RangeError', () => {
    expect(() => rsDecode(new Uint8Array(PARITY_BYTES))).toThrow(RangeError)
    expect(() => rsDecode(new Uint8Array(256))).toThrow(RangeError)
  })
})
