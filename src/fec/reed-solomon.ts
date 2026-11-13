// Reed-Solomon (255, 223) over GF(256) (design.md, "FEC_Codec").
//
// - Field from `../gf256/gf256` (0x11D, alpha = 0x02).
// - Generator g(x) = prod_{i=0}^{31} (x - alpha^i): first consecutive root alpha^0.
// - Systematic: codeword = data || (data(x) * x^32 mod g(x)).
// - Byte 0 of a codeword is the highest-degree coefficient, so byte j of an
//   n-byte codeword is the coefficient of x^(n-1-j).
// - Codewords shorter than 255 bytes are shortened codes: the missing leading
//   bytes are implicit zeros and are never sent.
// - Decoding: syndromes, Berlekamp-Massey, Chien search, Forney. Corrects up
//   to 16 byte errors per codeword.
//
// Wrong lengths are programming errors and throw RangeError, like gf256.
// Too much damage throws UncorrectableError with no blocks; the framer, which
// knows the block index, rethrows with the indices filled in.

import { UncorrectableError } from '../core/errors'
import { EXP, LOG, mul, polyEval } from '../gf256/gf256'

/** Parity bytes per codeword. */
export const PARITY_BYTES = 32

/** Data bytes in a full-length codeword. */
export const MAX_DATA_BYTES = 223

/** Longest codeword: 2^8 - 1 bytes. */
const MAX_CODEWORD_BYTES = 255

/** Most byte errors a codeword can have and still be corrected. */
const MAX_ERRORS = PARITY_BYTES / 2

/** g(x), highest degree first. `GENERATOR[0]` is 1 (monic), length 33. */
const GENERATOR: Uint8Array = (() => {
  let g = new Uint8Array([1])
  for (let i = 0; i < PARITY_BYTES; i++) {
    // Multiply by (x + alpha^i).
    const root = EXP[i]!
    const next = new Uint8Array(g.length + 1)
    for (let j = 0; j < g.length; j++) {
      next[j]! ^= g[j]!
      next[j + 1]! ^= mul(g[j]!, root)
    }
    g = next
  }
  return g
})()

/**
 * Encodes 1 to 223 data bytes. Returns `data` followed by 32 parity bytes.
 * Throws RangeError for any other length.
 */
export function rsEncode(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const k = data.length
  if (k < 1 || k > MAX_DATA_BYTES) throw new RangeError('data must be 1 to 223 bytes')

  // Long division of data(x) * x^32 by the monic g(x). `work` ends up holding
  // the quotient's trace in its first k bytes and the remainder after them.
  const out = new Uint8Array(k + PARITY_BYTES)
  out.set(data)
  const work = out.slice()
  for (let i = 0; i < k; i++) {
    const coef = work[i]!
    if (coef === 0) continue
    const logCoef = LOG[coef]!
    for (let j = 1; j <= PARITY_BYTES; j++) {
      const gj = GENERATOR[j]!
      if (gj !== 0) work[i + j]! ^= EXP[LOG[gj]! + logCoef]!
    }
  }
  out.set(work.subarray(k), k)
  return out
}

/** Evaluates a polynomial stored lowest degree first at `x`. */
function evalLowFirst(poly: Uint8Array, x: number): number {
  let y = 0
  for (let i = poly.length - 1; i >= 0; i--) y = mul(y, x) ^ poly[i]!
  return y
}

/** Computes S_i = c(alpha^i) for i = 0..31. Returns true if any is non-zero. */
function syndromes(codeword: Uint8Array, out: Uint8Array): boolean {
  let any = false
  for (let i = 0; i < PARITY_BYTES; i++) {
    const s = polyEval(codeword, EXP[i]!)
    out[i] = s
    if (s !== 0) any = true
  }
  return any
}

/**
 * Berlekamp-Massey. Returns the error locator Lambda(x), lowest degree first
 * with Lambda_0 = 1, and its claimed length L (number of errors).
 */
function berlekampMassey(s: Uint8Array): { lambda: Uint8Array; errors: number } {
  const size = PARITY_BYTES + 1
  const c = new Uint8Array(size)
  let b = new Uint8Array(size)
  c[0] = 1
  b[0] = 1
  let l = 0
  let m = 1
  let lastDiscrepancy = 1

  for (let n = 0; n < PARITY_BYTES; n++) {
    let d = s[n]!
    for (let i = 1; i <= l; i++) d ^= mul(c[i]!, s[n - i]!)

    if (d === 0) {
      m++
      continue
    }

    const scale = EXP[LOG[d]! + 255 - LOG[lastDiscrepancy]!]!
    if (2 * l <= n) {
      const previous = c.slice()
      for (let i = 0; i + m < size; i++) c[i + m]! ^= mul(scale, b[i]!)
      l = n + 1 - l
      b = previous
      lastDiscrepancy = d
      m = 1
    } else {
      for (let i = 0; i + m < size; i++) c[i + m]! ^= mul(scale, b[i]!)
      m++
    }
  }
  return { lambda: c.subarray(0, l + 1), errors: l }
}

/**
 * Decodes a codeword of 33 to 255 bytes (data followed by 32 parity bytes).
 * Returns the corrected data bytes and the number of byte positions repaired.
 * Does not modify `codeword`. Throws UncorrectableError when the codeword has
 * more than 16 byte errors and the decoder detects it, and RangeError for a
 * length outside 33 to 255.
 */
export function rsDecode(codeword: Uint8Array): { data: Uint8Array<ArrayBuffer>; corrected: number } {
  const n = codeword.length
  if (n <= PARITY_BYTES || n > MAX_CODEWORD_BYTES) {
    throw new RangeError('codeword must be 33 to 255 bytes')
  }
  const dataLength = n - PARITY_BYTES

  const s = new Uint8Array(PARITY_BYTES)
  if (!syndromes(codeword, s)) {
    return { data: codeword.slice(0, dataLength), corrected: 0 }
  }

  const { lambda, errors } = berlekampMassey(s)
  if (errors > MAX_ERRORS || lambda[errors] === 0) throw new UncorrectableError()

  // Chien search over the positions that exist in this (possibly shortened)
  // codeword. Byte j has power e = n - 1 - j and locator X = alpha^e; it is in
  // error when Lambda(X^-1) = 0. Roots at powers >= n would lie in the
  // implicit leading zeros, so they are not searched and the count falls short.
  const positions: number[] = []
  for (let e = 0; e < n; e++) {
    const xInv = EXP[(255 - e) % 255]!
    if (evalLowFirst(lambda, xInv) === 0) {
      positions.push(e)
      if (positions.length > errors) break
    }
  }
  if (positions.length !== errors) throw new UncorrectableError()

  // Error evaluator Omega(x) = S(x) * Lambda(x) mod x^32, lowest degree first.
  const omega = new Uint8Array(PARITY_BYTES)
  for (let i = 0; i < PARITY_BYTES; i++) {
    let v = 0
    for (let j = 0; j <= Math.min(i, errors); j++) v ^= mul(lambda[j]!, s[i - j]!)
    omega[i] = v
  }

  // Formal derivative Lambda'(x): in characteristic 2 only odd terms survive.
  const derivative = new Uint8Array(Math.max(errors, 1))
  for (let i = 1; i <= errors; i += 2) derivative[i - 1] = lambda[i]!

  // Forney with first consecutive root b0 = 0: Y = X^(1-b0) * Omega(X^-1) / Lambda'(X^-1).
  const fixed = codeword.slice()
  for (const e of positions) {
    const x = EXP[e]!
    const xInv = EXP[(255 - e) % 255]!
    const denominator = evalLowFirst(derivative, xInv)
    if (denominator === 0) throw new UncorrectableError()
    const numerator = mul(x, evalLowFirst(omega, xInv))
    if (numerator === 0) throw new UncorrectableError()
    const magnitude = EXP[LOG[numerator]! + 255 - LOG[denominator]!]!
    fixed[n - 1 - e]! ^= magnitude
  }

  // A valid correction always yields a codeword. Checking costs one more
  // syndrome pass and catches any inconsistency the steps above missed.
  if (syndromes(fixed, s)) throw new UncorrectableError()

  return { data: fixed.slice(0, dataLength), corrected: errors }
}
