// Seeded pseudo-random numbers for the Virtual_Tape_Channel
// (design.md, "Virtual_Tape_Channel", step 3).
//
// SIMULATION ONLY. This generator is fully predictable from its 32-bit seed.
// Never use it for a salt, IV, Shard set ID, Shamir coefficient, or any other
// security value; those come only from `crypto.getRandomValues`
// (Requirement 8.5, air-gap steering).

import { InputError } from '../core/errors'

/**
 * mulberry32: a 32-bit state generator with period 2³². Same seed, same
 * sequence, on every platform, because it uses only 32-bit integer operations.
 */
export class Mulberry32 {
  #state: number

  /** @param seed any safe integer; it is reduced to its low 32 bits */
  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new InputError('seed must be a whole number')
    this.#state = seed >>> 0
  }

  /** Next value as an unsigned 32-bit integer. */
  nextUint32(): number {
    this.#state = (this.#state + 0x6d2b79f5) | 0
    let t = this.#state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (t ^ (t >>> 14)) >>> 0
  }

  /** Next value, uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 4_294_967_296
  }
}

/**
 * Standard normal values (mean 0, standard deviation 1) from the Box-Muller
 * transform on a `Mulberry32`. Each pair of uniforms gives two normals; the
 * second is kept for the following call, so `next` allocates nothing.
 */
export class GaussianSource {
  readonly #uniform: Mulberry32
  #spare = 0
  #hasSpare = false

  constructor(seed: number) {
    this.#uniform = new Mulberry32(seed)
  }

  /** Next standard normal value. */
  next(): number {
    if (this.#hasSpare) {
      this.#hasSpare = false
      return this.#spare
    }
    const radius = boxMullerRadius(this.#uniform.next())
    const u = this.#uniform.next()
    const cos = Math.cos(2 * Math.PI * u)
    this.#spare = radius * sinFromCos(cos, u)
    this.#hasSpare = true
    return radius * cos
  }

  /**
   * Adds `scale` times the next standard normal value to each element of
   * `target`, in order. Gives the same values as calling `next` once per
   * element, but runs Box-Muller a pair at a time without per-sample calls.
   */
  addScaledTo(target: Float32Array, scale: number): void {
    const length = target.length
    let k = 0
    if (this.#hasSpare && length > 0) {
      this.#hasSpare = false
      target[0] = target[0]! + scale * this.#spare
      k = 1
    }
    const uniform = this.#uniform
    for (; k + 1 < length; k += 2) {
      const radius = boxMullerRadius(uniform.next())
      const u = uniform.next()
      const cos = Math.cos(2 * Math.PI * u)
      target[k] = target[k]! + scale * (radius * cos)
      target[k + 1] = target[k + 1]! + scale * (radius * sinFromCos(cos, u))
    }
    if (k < length) target[k] = target[k]! + scale * this.next()
  }
}

/** Box-Muller radius √(−2 ln(1 − u)); 1 − u lies in (0, 1], so the logarithm is finite. */
function boxMullerRadius(u: number): number {
  return Math.sqrt(-2 * Math.log(1 - u))
}

/**
 * sin(2πu) from cos(2πu): the magnitude is √(1 − cos²), and the sign is
 * positive for u < 0.5. One square root is cheaper than a second sine.
 */
function sinFromCos(cos: number, u: number): number {
  const magnitude = Math.sqrt(Math.max(0, 1 - cos * cos))
  return u < 0.5 ? magnitude : -magnitude
}
