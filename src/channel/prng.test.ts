import { describe, expect, it } from 'vitest'
import { InputError } from '../core/errors'
import { GaussianSource, Mulberry32 } from './prng'

function take(rng: { next(): number }, count: number): number[] {
  return Array.from({ length: count }, () => rng.next())
}

describe('Mulberry32', () => {
  it('repeats the same sequence for the same seed and differs for another seed', () => {
    expect(take(new Mulberry32(42), 16)).toEqual(take(new Mulberry32(42), 16))
    expect(take(new Mulberry32(42), 16)).not.toEqual(take(new Mulberry32(43), 16))
  })

  it('reduces the seed to its low 32 bits', () => {
    expect(take(new Mulberry32(-1), 8)).toEqual(take(new Mulberry32(0xffff_ffff), 8))
  })

  it('returns uniform values in [0, 1)', () => {
    const values = take(new Mulberry32(7), 100_000)
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    expect(mean).toBeCloseTo(0.5, 2)
  })

  it('rejects a seed that is not a safe integer', () => {
    expect(() => new Mulberry32(1.5)).toThrow(InputError)
    expect(() => new Mulberry32(Number.NaN)).toThrow(InputError)
  })
})

describe('GaussianSource', () => {
  it('produces mean 0 and standard deviation 1', () => {
    const values = take(new GaussianSource(1234), 200_000)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
    expect(values.every(Number.isFinite)).toBe(true)
    expect(Math.abs(mean)).toBeLessThan(0.01)
    expect(Math.sqrt(variance)).toBeCloseTo(1, 2)
  })

  it('repeats the same sequence for the same seed', () => {
    expect(take(new GaussianSource(99), 33)).toEqual(take(new GaussianSource(99), 33))
  })

  it('adds the same values with addScaledTo as with next, across odd-length blocks', () => {
    const scale = 0.25
    const single = new GaussianSource(17)
    const expected = Float32Array.from({ length: 21 }, () => scale * single.next())
    const bulk = new GaussianSource(17)
    const actual = new Float32Array(21)
    bulk.addScaledTo(actual.subarray(0, 5), scale)
    bulk.addScaledTo(actual.subarray(5, 12), scale)
    bulk.addScaledTo(actual.subarray(12), scale)
    expect(actual).toEqual(expected)
  })
})
