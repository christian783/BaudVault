// Arithmetic in GF(256), shared by the Shard_Codec (Shamir) and the FEC_Codec
// (Reed-Solomon). See design.md, "GF(256)".
//
// Field: primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1), generator
// alpha = 0x02. Elements are integers 0 to 255. Callers must pass values in
// that range; the hot-path functions do not check it.
//
// Division by zero throws RangeError: it is a programming error, not user
// input, so it does not use the BaudVaultError classes.

/** The primitive polynomial, including the x^8 term. */
export const PRIMITIVE_POLY = 0x11d

/** The generator of the multiplicative group. */
export const ALPHA = 0x02

/**
 * `EXP[i]` is alpha^i for 0 <= i < 510. The table is doubled so `mul` can add
 * two logarithms (each at most 254) without reducing modulo 255.
 * `EXP[510]` and `EXP[511]` repeat the cycle and are never needed by this module.
 * Treat as read-only.
 */
export const EXP: Uint8Array = new Uint8Array(512)

/**
 * `LOG[a]` is the i in 0..254 with alpha^i = a, for a in 1..255.
 * `LOG[0]` is undefined in the field and is stored as 0; never read it.
 * Treat as read-only.
 */
export const LOG: Uint8Array = new Uint8Array(256)

{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= PRIMITIVE_POLY
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!
}

/** Addition, which is also subtraction, in GF(256). */
export function add(a: number, b: number): number {
  return a ^ b
}

/** Multiplication in GF(256). */
export function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a]! + LOG[b]!]!
}

/** Division `a / b` in GF(256). Throws RangeError when `b` is 0. */
export function div(a: number, b: number): number {
  if (b === 0) throw new RangeError('division by zero in GF(256)')
  if (a === 0) return 0
  return EXP[LOG[a]! + 255 - LOG[b]!]!
}

/** Multiplicative inverse in GF(256). Throws RangeError when `a` is 0. */
export function inv(a: number): number {
  if (a === 0) throw new RangeError('inverse of zero in GF(256)')
  return EXP[255 - LOG[a]!]!
}

/**
 * `a` raised to the integer power `n` in GF(256). `n` may be negative.
 * `pow(0, 0)` is 1, and `pow(0, n)` is 0 for n > 0. Throws RangeError for a
 * non-integer `n` or for 0 raised to a negative power.
 */
export function pow(a: number, n: number): number {
  if (!Number.isInteger(n)) throw new RangeError('exponent must be an integer')
  if (n === 0) return 1
  if (a === 0) {
    if (n < 0) throw new RangeError('inverse of zero in GF(256)')
    return 0
  }
  const e = (((LOG[a]! * n) % 255) + 255) % 255
  return EXP[e]!
}

/**
 * Evaluates the polynomial with coefficients `coeffs` (highest degree first)
 * at `x`, using Horner's rule. An empty polynomial evaluates to 0.
 */
export function polyEval(coeffs: ArrayLike<number>, x: number): number {
  let y = 0
  for (let i = 0; i < coeffs.length; i++) y = mul(y, x) ^ coeffs[i]!
  return y
}
