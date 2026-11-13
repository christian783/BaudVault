// Sliding Goertzel detector for the two Kansas City Standard tones
// (design.md, "Goertzel and bit demodulator"; Requirement 5.2).
//
// Two sliding single-bin DFTs measure the energy of the last W samples at
// 1,200 Hz and 2,400 Hz, where W = round(sampleRate / baud) is one bit long.
// Each bin uses the recursive form
//
//   X ← (X + x[n] − e^{jωW} · x[n − W]) · e^{jω}
//
// in float64, which keeps X equal to Σ_{k=0}^{W−1} x[n − k] · e^{jω(k + 1)}.
// The factor e^{jωW} is 1 when the window holds a whole number of cycles
// (300 baud at 44.1 kHz), but not at 2,400 baud (0.49 and 0.98 cycles) or at
// rates such as 22,050 Hz, so it is always applied.
// Rounding error in the rotation accumulates slowly, so both sums are
// recomputed directly from the window every 4,096 samples.
//
// Energies are normalized by (2 / W)², so a tone of peak amplitude A centered
// in a bin reads about A². On that scale a −50 dBFS tone is 1e-5 and a −40 dBFS
// tone is 1e-4, whatever the sample rate or baud.

import { InputError } from '../core/errors'
import { type BaudRate, MARK_HZ, SPACE_HZ } from './kcs-modulator'

/** Samples between direct recomputations of the sliding sums. */
export const RECOMPUTE_INTERVAL = 4_096

/** ε in the decision signal: the normalized energy of a −50 dBFS tone over one window. */
export const DECISION_EPSILON = 10 ** (-50 / 10)

/** Carrier floor: the normalized energy of a −40 dBFS tone over one window. */
export const ENERGY_FLOOR = 10 ** (-40 / 10)

/** Lowest and highest sample rates the demodulator accepts (Requirement 5.4). */
export const MIN_SAMPLE_RATE = 22_050
export const MAX_SAMPLE_RATE = 96_000

/** Throws `InputError` unless `sampleRate` is within 22,050 to 96,000 Hz. */
export function checkSampleRate(sampleRate: number): void {
  if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new InputError('unsupported sample rate', sampleRate, 'Hz')
  }
}

/** Throws `InputError` unless `baud` is 300 or 2,400. */
export function checkBaud(baud: BaudRate): void {
  if (baud !== 300 && baud !== 2400) throw new InputError('unsupported baud rate', baud)
}

/** Goertzel window length in samples: round(sampleRate / baud), one bit period. */
export function windowLength(sampleRate: number, baud: BaudRate): number {
  checkSampleRate(sampleRate)
  checkBaud(baud)
  return Math.round(sampleRate / baud)
}

/**
 * Sliding 1,200 Hz and 2,400 Hz energy detector over a window of one bit.
 * Call `step` once per input sample; it allocates nothing.
 */
export class SlidingGoertzel {
  /** Window length W in samples. */
  readonly windowLength: number

  readonly #ring: Float64Array
  #pos = 0
  #sinceRecompute = 0

  // Rotation e^{jω} for each tone.
  readonly #markCos: number
  readonly #markSin: number
  readonly #spaceCos: number
  readonly #spaceSin: number

  // e^{jωW} for each tone, applied to the sample leaving the window.
  readonly #markOutCos: number
  readonly #markOutSin: number
  readonly #spaceOutCos: number
  readonly #spaceOutSin: number

  // Weights e^{jω(k + 1)} for the direct recomputation, k = 0 is the newest sample.
  readonly #markCosTab: Float64Array
  readonly #markSinTab: Float64Array
  readonly #spaceCosTab: Float64Array
  readonly #spaceSinTab: Float64Array

  readonly #scale: number

  #markRe = 0
  #markIm = 0
  #spaceRe = 0
  #spaceIm = 0

  #mark = 0
  #space = 0

  constructor(sampleRate: number, windowLength: number) {
    checkSampleRate(sampleRate)
    if (!Number.isInteger(windowLength) || windowLength < 2) {
      throw new InputError('window length must be a whole number of at least 2 samples', windowLength)
    }
    this.windowLength = windowLength
    this.#ring = new Float64Array(windowLength)
    this.#scale = 4 / (windowLength * windowLength)

    const markStep = (2 * Math.PI * MARK_HZ) / sampleRate
    const spaceStep = (2 * Math.PI * SPACE_HZ) / sampleRate
    this.#markCos = Math.cos(markStep)
    this.#markSin = Math.sin(markStep)
    this.#spaceCos = Math.cos(spaceStep)
    this.#spaceSin = Math.sin(spaceStep)
    this.#markOutCos = Math.cos(markStep * windowLength)
    this.#markOutSin = Math.sin(markStep * windowLength)
    this.#spaceOutCos = Math.cos(spaceStep * windowLength)
    this.#spaceOutSin = Math.sin(spaceStep * windowLength)

    this.#markCosTab = new Float64Array(windowLength)
    this.#markSinTab = new Float64Array(windowLength)
    this.#spaceCosTab = new Float64Array(windowLength)
    this.#spaceSinTab = new Float64Array(windowLength)
    for (let k = 0; k < windowLength; k++) {
      this.#markCosTab[k] = Math.cos(markStep * (k + 1))
      this.#markSinTab[k] = Math.sin(markStep * (k + 1))
      this.#spaceCosTab[k] = Math.cos(spaceStep * (k + 1))
      this.#spaceSinTab[k] = Math.sin(spaceStep * (k + 1))
    }
  }

  /** Normalized 2,400 Hz energy of the current window. */
  get mark(): number {
    return this.#mark
  }

  /** Normalized 1,200 Hz energy of the current window. */
  get space(): number {
    return this.#space
  }

  /**
   * Adds one sample, slides the window by one, and returns the decision
   * signal d = (E₂₄₀₀ − E₁₂₀₀) / (E₂₄₀₀ + E₁₂₀₀ + ε) in [−1, 1].
   * Positive means mark (bit 1), negative means space (bit 0).
   */
  step(x: number): number {
    const ring = this.#ring
    const pos = this.#pos
    const old = ring[pos]!
    ring[pos] = x
    this.#pos = pos + 1 === ring.length ? 0 : pos + 1

    if (++this.#sinceRecompute >= RECOMPUTE_INTERVAL) {
      this.#sinceRecompute = 0
      this.#recompute()
    } else {
      let re = this.#markRe + x - old * this.#markOutCos
      let im = this.#markIm - old * this.#markOutSin
      this.#markRe = re * this.#markCos - im * this.#markSin
      this.#markIm = re * this.#markSin + im * this.#markCos

      re = this.#spaceRe + x - old * this.#spaceOutCos
      im = this.#spaceIm - old * this.#spaceOutSin
      this.#spaceRe = re * this.#spaceCos - im * this.#spaceSin
      this.#spaceIm = re * this.#spaceSin + im * this.#spaceCos
    }

    const mark = (this.#markRe * this.#markRe + this.#markIm * this.#markIm) * this.#scale
    const space = (this.#spaceRe * this.#spaceRe + this.#spaceIm * this.#spaceIm) * this.#scale
    this.#mark = mark
    this.#space = space
    return (mark - space) / (mark + space + DECISION_EPSILON)
  }

  /** Recomputes both sums directly from the window to discard accumulated rounding error. */
  #recompute(): void {
    const ring = this.#ring
    const w = ring.length
    let markRe = 0
    let markIm = 0
    let spaceRe = 0
    let spaceIm = 0
    // The newest sample sits just before #pos.
    let idx = this.#pos === 0 ? w - 1 : this.#pos - 1
    for (let k = 0; k < w; k++) {
      const v = ring[idx]!
      markRe += v * this.#markCosTab[k]!
      markIm += v * this.#markSinTab[k]!
      spaceRe += v * this.#spaceCosTab[k]!
      spaceIm += v * this.#spaceSinTab[k]!
      idx = idx === 0 ? w - 1 : idx - 1
    }
    this.#markRe = markRe
    this.#markIm = markIm
    this.#spaceRe = spaceRe
    this.#spaceIm = spaceIm
  }
}
