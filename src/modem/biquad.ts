// Second-order IIR filters for the Virtual_Tape_Channel bandpass
// (design.md, "Virtual_Tape_Channel", step 1).
//
// Coefficients follow Robert Bristow-Johnson's "Audio EQ Cookbook". With
// Q = 1/√2 the low-pass and high-pass sections are 2nd-order Butterworth
// filters, −3.01 dB at the cutoff (the bilinear transform is prewarped so the
// cutoff lands exactly on f₀). The filter runs in transposed direct form II
// with float64 state.

import { InputError } from '../core/errors'

/** Q of a 2nd-order Butterworth section. */
export const BUTTERWORTH_Q = Math.SQRT1_2

/** Normalized biquad coefficients (a₀ = 1). */
type Coefficients = { b0: number; b1: number; b2: number; a1: number; a2: number }

/** One biquad section with its own state. */
export class Biquad {
  readonly #b0: number
  readonly #b1: number
  readonly #b2: number
  readonly #a1: number
  readonly #a2: number
  #z1 = 0
  #z2 = 0

  private constructor(c: Coefficients) {
    this.#b0 = c.b0
    this.#b1 = c.b1
    this.#b2 = c.b2
    this.#a1 = c.a1
    this.#a2 = c.a2
  }

  /** RBJ low-pass at `cutoff` Hz. */
  static lowPass(sampleRate: number, cutoff: number, q: number = BUTTERWORTH_Q): Biquad {
    const { cos, alpha } = prepare(sampleRate, cutoff, q)
    const a0 = 1 + alpha
    const b = (1 - cos) / 2 / a0
    return new Biquad({ b0: b, b1: 2 * b, b2: b, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 })
  }

  /** RBJ high-pass at `cutoff` Hz. */
  static highPass(sampleRate: number, cutoff: number, q: number = BUTTERWORTH_Q): Biquad {
    const { cos, alpha } = prepare(sampleRate, cutoff, q)
    const a0 = 1 + alpha
    const b = (1 + cos) / 2 / a0
    return new Biquad({ b0: b, b1: -2 * b, b2: b, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 })
  }

  /** Filters one sample. */
  step(x: number): number {
    const y = this.#b0 * x + this.#z1
    this.#z1 = this.#b1 * x - this.#a1 * y + this.#z2
    this.#z2 = this.#b2 * x - this.#a2 * y
    return y
  }

  /** Filters `buffer` in place, continuing from the current state. Allocates nothing. */
  processInPlace(buffer: Float64Array): void {
    const b0 = this.#b0
    const b1 = this.#b1
    const b2 = this.#b2
    const a1 = this.#a1
    const a2 = this.#a2
    let z1 = this.#z1
    let z2 = this.#z2
    for (let n = 0; n < buffer.length; n++) {
      const x = buffer[n]!
      const y = b0 * x + z1
      z1 = b1 * x - a1 * y + z2
      z2 = b2 * x - a2 * y
      buffer[n] = y
    }
    this.#z1 = z1
    this.#z2 = z2
  }

  /** Clears the filter state. */
  reset(): void {
    this.#z1 = 0
    this.#z2 = 0
  }
}

/** Validates the arguments and returns cos(ω₀) and α = sin(ω₀) / (2Q). */
function prepare(sampleRate: number, cutoff: number, q: number): { cos: number; alpha: number } {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new InputError('unsupported sample rate', sampleRate, 'Hz')
  if (!Number.isFinite(cutoff) || cutoff <= 0 || cutoff >= sampleRate / 2) {
    throw new InputError('filter cutoff must be between 0 Hz and half the sample rate', cutoff, 'Hz')
  }
  if (!Number.isFinite(q) || q <= 0) throw new InputError('filter Q must be positive', q)
  const w0 = (2 * Math.PI * cutoff) / sampleRate
  return { cos: Math.cos(w0), alpha: Math.sin(w0) / (2 * q) }
}
