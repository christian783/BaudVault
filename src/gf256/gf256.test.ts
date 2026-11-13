import { describe, expect, it } from 'vitest'
import { add, ALPHA, div, EXP, inv, LOG, mul, polyEval, pow, PRIMITIVE_POLY } from './gf256'

/** Carry-less multiply reduced by 0x11D, bit by bit, as an independent reference for `mul`. */
function slowMul(a: number, b: number): number {
  let result = 0
  for (let i = 0; i < 8; i++) {
    if (b & (1 << i)) result ^= a << i
  }
  for (let bit = 15; bit >= 8; bit--) {
    if (result & (1 << bit)) result ^= PRIMITIVE_POLY << (bit - 8)
  }
  return result
}

describe('GF(256) tables', () => {
  it('uses primitive polynomial 0x11D and generator 0x02', () => {
    expect(PRIMITIVE_POLY).toBe(0x11d)
    expect(ALPHA).toBe(0x02)
  })

  it('alpha generates all 255 non-zero elements', () => {
    const seen = new Set<number>()
    for (let i = 0; i < 255; i++) seen.add(EXP[i]!)
    expect(seen.size).toBe(255)
    expect(seen.has(0)).toBe(false)
  })

  it('has alpha^0 = alpha^255 = 1', () => {
    expect(EXP[0]).toBe(1)
    expect(EXP[255]).toBe(1)
    expect(pow(ALPHA, 255)).toBe(1)
  })

  it('keeps EXP and LOG consistent', () => {
    for (let a = 1; a < 256; a++) expect(EXP[LOG[a]!]).toBe(a)
    for (let i = 0; i < 255; i++) expect(LOG[EXP[i]!]).toBe(i)
  })

  it('doubles the EXP table', () => {
    for (let i = 255; i < 512; i++) expect(EXP[i]).toBe(EXP[i - 255])
  })
})

describe('GF(256) arithmetic', () => {
  it('adds with XOR', () => {
    expect(add(0x53, 0xca)).toBe(0x99)
    expect(add(0x7f, 0x7f)).toBe(0)
  })

  it('reduces by 0x11D on overflow', () => {
    expect(mul(0x80, 2)).toBe(0x1d)
  })

  it('matches a bitwise reference multiply for every pair', () => {
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        if (mul(a, b) !== slowMul(a, b)) expect(mul(a, b)).toBe(slowMul(a, b))
      }
    }
  })

  it('has 0 as absorbing and 1 as identity', () => {
    for (let a = 0; a < 256; a++) {
      expect(mul(a, 0)).toBe(0)
      expect(mul(0, a)).toBe(0)
      expect(mul(a, 1)).toBe(a)
    }
  })

  it('gives every non-zero element an inverse', () => {
    for (let a = 1; a < 256; a++) {
      expect(mul(a, inv(a))).toBe(1)
      expect(div(1, a)).toBe(inv(a))
    }
  })

  it('makes division undo multiplication', () => {
    for (let a = 0; a < 256; a += 7) {
      for (let b = 1; b < 256; b += 5) expect(div(mul(a, b), b)).toBe(a)
    }
  })

  it('distributes multiplication over addition', () => {
    const samples = [0, 1, 2, 3, 0x1d, 0x53, 0x80, 0xca, 0xff]
    for (const a of samples) {
      for (const b of samples) {
        for (const c of samples) expect(mul(a, add(b, c))).toBe(add(mul(a, b), mul(a, c)))
      }
    }
  })

  it('throws RangeError on division by zero and on inverse of zero', () => {
    expect(() => div(5, 0)).toThrow(RangeError)
    expect(() => div(0, 0)).toThrow(RangeError)
    expect(() => inv(0)).toThrow(RangeError)
  })
})

describe('pow', () => {
  it('agrees with repeated multiplication', () => {
    for (const a of [2, 3, 0x53, 0xff]) {
      let expected = 1
      for (let n = 0; n < 300; n++) {
        expect(pow(a, n)).toBe(expected)
        expected = mul(expected, a)
      }
    }
  })

  it('handles negative exponents as inverses', () => {
    for (let a = 1; a < 256; a++) {
      expect(pow(a, -1)).toBe(inv(a))
      expect(mul(pow(a, -3), pow(a, 3))).toBe(1)
    }
  })

  it('handles zero', () => {
    expect(pow(0, 0)).toBe(1)
    expect(pow(0, 5)).toBe(0)
    expect(() => pow(0, -1)).toThrow(RangeError)
  })

  it('rejects non-integer exponents', () => {
    expect(() => pow(2, 1.5)).toThrow(RangeError)
  })
})

describe('polyEval', () => {
  it('evaluates an empty polynomial to 0', () => {
    expect(polyEval([], 7)).toBe(0)
  })

  it('returns the constant term at x = 0', () => {
    expect(polyEval([0x12, 0x34, 0x56], 0)).toBe(0x56)
  })

  it('evaluates highest degree first', () => {
    // x^2 + 3x + 5 at x = 2: 4 ^ 6 ^ 5 = 7.
    expect(polyEval([1, 3, 5], 2)).toBe(7)
    // 0x53·x + 0x01 at x = 0xca.
    expect(polyEval([0x53, 0x01], 0xca)).toBe(mul(0x53, 0xca) ^ 1)
  })

  it('finds alpha^i as a root of (x - alpha^i)', () => {
    for (let i = 0; i < 255; i++) expect(polyEval([1, EXP[i]!], EXP[i]!)).toBe(0)
  })
})
