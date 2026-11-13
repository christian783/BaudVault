// Bit demodulator: turns KCS audio into bytes (design.md, "Goertzel and bit
// demodulator"; Requirements 5.2 and 5.7).
//
// At 2,400 baud the input first passes a 700 Hz to 3,500 Hz bandpass (two
// 2nd-order Butterworth biquads) that removes out-of-band hiss. 300 baud needs
// no pre-filter. Per sample, a SlidingGoertzel then gives the decision signal
// d[n] in [−1, 1] (positive = mark). On top of d the demodulator runs three
// states:
//
// - Search: wait for Carrier_Lock, which needs d above the lock threshold
//   (0.5 at 300 baud, 0 at 2,400 baud) and total energy above the −40 dBFS
//   floor for 0.5 s without a break.
// - Hunt: after lock, find the first mark-to-space crossing of d. The window
//   is one bit long, so the crossing lags the edge by about half a bit:
//   t_edge = t_cross − W / 2. Accept it only if d < 0 at t_edge + T.
// - Frame: decide bit i (0 start, 1–8 data LSB first, 9–10 stop) by the sign
//   of d at t_edge + (i + 1) · T and emit the byte. A byte clock then sets the
//   next start edge to t_edge + 11 · T plus a bounded correction, so exactly
//   one byte is emitted per frame period while lock is held, and no start-bit
//   search happens after the first frame.
//
// Byte clock. Each frame gives a timing error from all of its bit transitions,
// including stop → next start. The start (0) and stop (1, 1) bits are known,
// the data bits are the decisions just made. At a transition between bit j − 1
// and bit j, d at the mid-point of their decision points, t_edge + (j + ½)·T,
// is about 0 when the clock is right and takes the old bit's sign when the
// clock is early. The mean of these signed samples, times W and a loop gain,
// is the correction, clamped per frame (CLOCK). Because d is bounded and the
// correction is clamped well under half a bit, one noisy start or stop bit
// moves the clock by a fraction of a bit and can never slip it by whole bits.
// A second-order term moves T by `periodGain · correction / 11`, clamped to
// ±10% of nominal, so T follows wow-and-flutter.
//
// Lock is lost after 22 bit periods with total energy below the floor, or when
// the caller calls `release()`.
//
// Every decision depends only on the absolute sample index, so splitting the
// input into chunks of any size gives the same events as one big push. The
// per-sample loop allocates nothing; d is kept in a ring buffer so the frame
// step can read the whole frame after it has passed.

import { InputError } from '../core/errors'
import { Biquad } from './biquad'
import { checkBaud, checkSampleRate, ENERGY_FLOOR, SlidingGoertzel } from './goertzel'
import { type BaudRate, BITS_PER_FRAME } from './kcs-modulator'

/** Seconds of unbroken leader needed for Carrier_Lock. */
export const LOCK_SECONDS = 0.5
/** Bit periods of energy below the floor after which Carrier_Lock is lost. */
export const UNLOCK_BITS = 22
/**
 * Byte-clock loop constants per baud (measured, design.md "D1 re-measurement").
 * - `gain`: correction in window lengths W per unit of mean signed mid-point d.
 * - `periodGain`: share of each correction that also moves T (second order).
 * - `maxStep`: largest correction per frame, as a fraction of a nominal bit.
 *   At 2,400 baud, 0.16 bit is 2.9 samples at 44.1 kHz. The 2% wow model drifts
 *   at most about 4 samples per frame at its 0.5 Hz peak, but the T loop takes
 *   up the slow part, leaving about 0.8 samples per frame of 12 Hz flutter;
 *   1.5 samples (0.08 bit) still passed at 2% but failed at 4% wow.
 *   At 300 baud a frame lasts 1,617 samples and 2% wow drifts about 26 samples
 *   per frame, so the clamp is 0.4 bit.
 */
export const CLOCK = {
  300: { gain: 0.25, periodGain: 0.25, maxStep: 0.4 },
  2400: { gain: 1.4, periodGain: 0.4, maxStep: 0.16 },
} as const

/** Bandpass edges of the 2,400-baud pre-filter in Hz. */
export const TURBO_BAND_LOW_HZ = 700
export const TURBO_BAND_HIGH_HZ = 3_500
/** Largest allowed deviation of the bit-period estimate from nominal. */
export const MAX_PERIOD_DEVIATION = 0.1

/**
 * d must exceed this during the leader. At 2,400 baud the one-bit window holds
 * half a cycle of 1,200 Hz, so a clean mark tone dips to d ≈ 0.16, and the
 * threshold is 0 (design.md, "Carrier_Lock").
 */
export function lockThreshold(baud: BaudRate): number {
  return baud === 300 ? 0.5 : 0
}

export type DemodEvent =
  | { readonly type: 'lock'; readonly sample: number }
  | { readonly type: 'unlock'; readonly sample: number }
  | { readonly type: 'byte'; readonly value: number; readonly sample: number }

const SEARCH = 0
const HUNT = 1
const FRAME = 2
type State = typeof SEARCH | typeof HUNT | typeof FRAME

export class BitDemodulator {
  readonly sampleRate: number
  readonly baud: BaudRate
  /** Goertzel window W in samples. */
  readonly windowLength: number
  /** Latest normalized tone energies (a centered tone of peak A reads about A²), for the UI bars. */
  readonly energies: { mark: number; space: number } = { mark: 0, space: 0 }

  readonly #goertzel: SlidingGoertzel
  /** 2,400-baud bandpass sections, or null at 300 baud. */
  readonly #highPass: Biquad | null
  readonly #lowPass: Biquad | null
  readonly #clockGain: number
  readonly #periodGain: number
  readonly #maxStep: number
  readonly #nominalPeriod: number
  readonly #minPeriod: number
  readonly #maxPeriod: number
  readonly #lockThreshold: number
  readonly #lockSamples: number
  readonly #unlockSamples: number

  readonly #history: Float64Array
  readonly #mask: number

  /** Absolute index of the next input sample. */
  #n = 0
  #prevD = 0
  #state: State = SEARCH
  #lockRun = 0
  #silenceRun = 0

  /** Current bit period estimate T in samples. */
  #period: number
  /** Start edge of the current frame (fractional sample index). */
  #edge = 0
  /** Hunt: candidate edge waiting for its d < 0 check. */
  #candidate = 0
  /** First sample index at which the pending step can run; Infinity when none. */
  #readyAt = Infinity

  constructor(sampleRate: number, baud: BaudRate) {
    checkSampleRate(sampleRate)
    checkBaud(baud)
    this.sampleRate = sampleRate
    this.baud = baud
    this.#nominalPeriod = sampleRate / baud
    this.windowLength = Math.round(this.#nominalPeriod)
    this.#goertzel = new SlidingGoertzel(sampleRate, this.windowLength)
    const turbo = baud === 2400
    this.#highPass = turbo ? Biquad.highPass(sampleRate, TURBO_BAND_LOW_HZ) : null
    this.#lowPass = turbo ? Biquad.lowPass(sampleRate, TURBO_BAND_HIGH_HZ) : null
    const clock = CLOCK[baud]
    this.#clockGain = clock.gain * this.windowLength
    this.#periodGain = clock.periodGain
    this.#maxStep = clock.maxStep * this.#nominalPeriod
    this.#minPeriod = this.#nominalPeriod * (1 - MAX_PERIOD_DEVIATION)
    this.#maxPeriod = this.#nominalPeriod * (1 + MAX_PERIOD_DEVIATION)
    this.#period = this.#nominalPeriod
    this.#lockThreshold = lockThreshold(baud)
    this.#lockSamples = Math.round(LOCK_SECONDS * sampleRate)
    this.#unlockSamples = Math.round(UNLOCK_BITS * this.#nominalPeriod)

    // The frame step reads d up to 11 bit periods back; keep a margin.
    let size = 64
    while (size < 13 * this.#maxPeriod + 64) size *= 2
    this.#history = new Float64Array(size)
    this.#mask = size - 1
  }

  /** True while Carrier_Lock is held. */
  get locked(): boolean {
    return this.#state !== SEARCH
  }

  /** Current bit period estimate T in samples. */
  get bitPeriod(): number {
    return this.#period
  }

  /** Number of samples consumed so far; event `sample` fields count from 0. */
  get samplesConsumed(): number {
    return this.#n
  }

  /**
   * Drops Carrier_Lock and returns to carrier search. Emits no event: the
   * caller (the Tape_Decoder) already knows it released the lock.
   */
  release(): void {
    this.#toSearch()
  }

  /**
   * Feeds samples and returns the events they produced, in order. Chunk
   * boundaries do not affect the result.
   *
   * @param decisionOut if given, receives d[n] for each input sample (trace B
   *   of the oscilloscope); it must be at least `samples.length` long
   * @throws InputError if `decisionOut` is too short
   */
  push(samples: Float32Array, decisionOut?: Float32Array): DemodEvent[] {
    if (decisionOut !== undefined && decisionOut.length < samples.length) {
      throw new InputError('decision buffer is shorter than the input', decisionOut.length)
    }
    const events: DemodEvent[] = []
    const goertzel = this.#goertzel
    const history = this.#history
    const mask = this.#mask
    const len = samples.length

    for (let i = 0; i < len; i++) {
      let x = samples[i]!
      // Non-finite input would poison the sliding sums; treat it as silence.
      if (x - x !== 0) x = 0
      if (this.#highPass !== null) x = this.#lowPass!.step(this.#highPass.step(x))
      const d = goertzel.step(x)
      const n = this.#n
      history[n & mask] = d
      if (decisionOut !== undefined) decisionOut[i] = d
      const total = goertzel.mark + goertzel.space

      if (this.#state === SEARCH) {
        if (d > this.#lockThreshold && total > ENERGY_FLOOR) {
          if (++this.#lockRun >= this.#lockSamples) {
            this.#state = HUNT
            this.#readyAt = Infinity
            this.#silenceRun = 0
            this.#period = this.#nominalPeriod
            events.push({ type: 'lock', sample: n })
          }
        } else {
          this.#lockRun = 0
        }
      } else if (total < ENERGY_FLOOR && ++this.#silenceRun >= this.#unlockSamples) {
        this.#toSearch()
        events.push({ type: 'unlock', sample: n })
      } else {
        if (total >= ENERGY_FLOOR) this.#silenceRun = 0
        if (this.#state === HUNT && this.#readyAt === Infinity) {
          const prev = this.#prevD
          if (prev >= 0 && d < 0) {
            const cross = n - 1 + prev / (prev - d)
            this.#candidate = cross - this.windowLength / 2
            this.#readyAt = Math.floor(this.#candidate + this.#period) + 1
          }
        }
        while (n >= this.#readyAt) this.#step(n, events)
      }

      this.#prevD = d
      this.#n = n + 1
    }

    this.energies.mark = goertzel.mark
    this.energies.space = goertzel.space
    return events
  }

  #toSearch(): void {
    this.#state = SEARCH
    this.#lockRun = 0
    this.#silenceRun = 0
    this.#readyAt = Infinity
  }

  /** Linear interpolation of d at a fractional position; needs floor(pos) + 1 ≤ the current sample. */
  #dAt(pos: number): number {
    const i0 = Math.floor(pos)
    const a = this.#history[i0 & this.#mask]!
    const b = this.#history[(i0 + 1) & this.#mask]!
    return a + (pos - i0) * (b - a)
  }

  /** Schedules the frame step: it runs once the mid-point after the frame's last bit is in the history. */
  #scheduleFrame(): void {
    this.#readyAt = Math.floor(this.#edge + (BITS_PER_FRAME + 0.5) * this.#period) + 1
  }

  /** Runs the pending step. Called only when the current sample index has reached `#readyAt`. */
  #step(n: number, events: DemodEvent[]): void {
    if (this.#state === HUNT) {
      if (this.#dAt(this.#candidate + this.#period) < 0) {
        this.#state = FRAME
        this.#edge = this.#candidate
        this.#scheduleFrame()
      } else {
        this.#readyAt = Infinity // noise spike: keep hunting
      }
      return
    }

    // FRAME: decide data bits 1–8, then run the byte clock.
    const period = this.#period
    const edge = this.#edge
    let byte = 0
    for (let bit = 1; bit <= 8; bit++) {
      if (this.#dAt(edge + (bit + 1) * period) > 0) byte |= 1 << (bit - 1)
    }
    events.push({ type: 'byte', value: byte, sample: n })

    // Byte clock: signed d at the mid-point of every transition (see top).
    let ted = 0
    let transitions = 0
    let prev = 0 // bit 0, the start bit
    for (let j = 1; j <= BITS_PER_FRAME; j++) {
      const cur = j <= 8 ? (byte >> (j - 1)) & 1 : j < BITS_PER_FRAME ? 1 : 0
      if (cur !== prev) {
        const mid = this.#dAt(edge + (j + 0.5) * period)
        ted += prev === 1 ? mid : -mid
        transitions++
      }
      prev = cur
    }
    // Every frame has at least two transitions: start → first 1, and stop → next start.
    const lim = this.#maxStep
    let corr = (this.#clockGain * ted) / transitions
    if (corr > lim) corr = lim
    else if (corr < -lim) corr = -lim

    let next = period + (this.#periodGain * corr) / BITS_PER_FRAME
    if (next < this.#minPeriod) next = this.#minPeriod
    else if (next > this.#maxPeriod) next = this.#maxPeriod
    this.#period = next
    this.#edge = edge + BITS_PER_FRAME * period + corr
    this.#scheduleFrame()
  }
}

/**
 * Demodulates a whole signal and returns up to `count` bytes from the first
 * Carrier_Lock. Fewer bytes come back if the signal ends or lock is lost first.
 *
 * @throws InputError for an unsupported sample rate or baud, or a bad `count`
 */
export function demodulateBytes(samples: Float32Array, sampleRate: number, baud: BaudRate, count: number): Uint8Array {
  if (!Number.isInteger(count) || count < 0) throw new InputError('byte count must be a whole number', count)
  const demod = new BitDemodulator(sampleRate, baud)
  const out = new Uint8Array(count)
  let received = 0
  const chunk = 8_192
  for (let start = 0; start < samples.length && received < count; start += chunk) {
    for (const event of demod.push(samples.subarray(start, start + chunk))) {
      if (event.type === 'byte') {
        out[received++] = event.value
        if (received === count) break
      } else if (event.type === 'unlock') {
        return out.slice(0, received)
      }
    }
  }
  return received === count ? out : out.slice(0, received)
}
