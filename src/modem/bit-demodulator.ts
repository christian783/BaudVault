// Bit demodulator: turns KCS audio into bytes (design.md, "Goertzel and bit
// demodulator"; Requirements 5.2 and 5.7).
//
// Per sample, a SlidingGoertzel gives the decision signal d[n] in [−1, 1]
// (positive = mark). On top of d the demodulator runs three states:
//
// - Search: wait for Carrier_Lock, which needs d above the lock threshold
//   (0.5 at 300 baud, 0 at 2,400 baud) and total energy above the −40 dBFS
//   floor for 0.5 s without a break.
// - Hunt: after lock, find the first mark-to-space crossing of d. The window
//   is one bit long, so the crossing lags the edge by about half a bit:
//   t_edge = t_cross − W / 2. Accept it only if d < 0 at t_edge + T.
// - Frame: decide bit i (0 start, 1–8 data LSB first, 9–10 stop) by the sign
//   of d at t_edge + (i + 1) · T, emit the byte after bit 8, then search for the
//   next start edge within ±0.5 T of t_edge + 11 · T. A found edge realigns
//   the clock and nudges T by a quarter of the error, clamped to ±10% of
//   nominal. A missing edge leaves t_edge at the expected point (flywheel), so
//   exactly one byte is emitted per frame period while lock is held.
//
// Lock is lost after 22 bit periods with total energy below the floor, or when
// the caller calls `release()`.
//
// Every decision depends only on the absolute sample index, so splitting the
// input into chunks of any size gives the same events as one big push. The
// per-sample loop allocates nothing; d is kept in a small ring buffer so events
// can read positions slightly in the past.

import { InputError } from '../core/errors'
import { checkBaud, checkSampleRate, ENERGY_FLOOR, SlidingGoertzel } from './goertzel'
import { type BaudRate, BITS_PER_FRAME } from './kcs-modulator'

/** Seconds of unbroken leader needed for Carrier_Lock. */
export const LOCK_SECONDS = 0.5
/** Bit periods of energy below the floor after which Carrier_Lock is lost. */
export const UNLOCK_BITS = 22
/** Fraction of the measured bit-period error applied at each realignment. */
export const CLOCK_GAIN = 0.25
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

/** Bit index of the "search for the next start edge" step in the Frame state. */
const NEXT_EDGE = 9

export class BitDemodulator {
  readonly sampleRate: number
  readonly baud: BaudRate
  /** Goertzel window W in samples. */
  readonly windowLength: number
  /** Latest normalized tone energies (a centered tone of peak A reads about A²), for the UI bars. */
  readonly energies: { mark: number; space: number } = { mark: 0, space: 0 }

  readonly #goertzel: SlidingGoertzel
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
  /** Frame: next bit to sample (1–8), or NEXT_EDGE. */
  #bit = 1
  #byte = 0

  constructor(sampleRate: number, baud: BaudRate) {
    checkSampleRate(sampleRate)
    checkBaud(baud)
    this.sampleRate = sampleRate
    this.baud = baud
    this.#nominalPeriod = sampleRate / baud
    this.windowLength = Math.round(this.#nominalPeriod)
    this.#goertzel = new SlidingGoertzel(sampleRate, this.windowLength)
    this.#minPeriod = this.#nominalPeriod * (1 - MAX_PERIOD_DEVIATION)
    this.#maxPeriod = this.#nominalPeriod * (1 + MAX_PERIOD_DEVIATION)
    this.#period = this.#nominalPeriod
    this.#lockThreshold = lockThreshold(baud)
    this.#lockSamples = Math.round(LOCK_SECONDS * sampleRate)
    this.#unlockSamples = Math.round(UNLOCK_BITS * this.#nominalPeriod)

    // Steps read d at most about two bit periods back; keep a generous margin.
    let size = 64
    while (size < 8 * this.#maxPeriod + 64) size *= 2
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

  /** Schedules sampling of bit `bit` of the current frame. */
  #scheduleBit(bit: number): void {
    this.#bit = bit
    this.#readyAt = Math.floor(this.#edge + (bit + 1) * this.#period) + 1
  }

  /** Runs the pending step. Called only when the current sample index has reached `#readyAt`. */
  #step(n: number, events: DemodEvent[]): void {
    if (this.#state === HUNT) {
      if (this.#dAt(this.#candidate + this.#period) < 0) {
        this.#state = FRAME
        this.#edge = this.#candidate
        this.#byte = 0
        this.#scheduleBit(1)
      } else {
        this.#readyAt = Infinity // noise spike: keep hunting
      }
      return
    }

    const bit = this.#bit
    if (bit <= 8) {
      if (this.#dAt(this.#edge + (bit + 1) * this.#period) > 0) this.#byte |= 1 << (bit - 1)
      if (bit < 8) {
        this.#scheduleBit(bit + 1)
      } else {
        events.push({ type: 'byte', value: this.#byte, sample: n })
        this.#bit = NEXT_EDGE
        const center = this.#edge + BITS_PER_FRAME * this.#period + this.windowLength / 2
        this.#readyAt = Math.floor(center + 0.5 * this.#period) + 1
      }
      return
    }

    // NEXT_EDGE: look for a mark-to-space crossing of d whose edge estimate is
    // within ±0.5 T of the expected start edge; take the one closest to it.
    const period = this.#period
    const expected = this.#edge + BITS_PER_FRAME * period
    const center = expected + this.windowLength / 2
    const lo = center - 0.5 * period
    const hi = center + 0.5 * period
    const history = this.#history
    const mask = this.#mask
    let best = NaN
    let bestDistance = Infinity
    const last = Math.floor(hi) + 1
    for (let m = Math.floor(lo) + 1; m <= last; m++) {
      const a = history[(m - 1) & mask]!
      const b = history[m & mask]!
      if (a >= 0 && b < 0) {
        const cross = m - 1 + a / (a - b)
        const distance = Math.abs(cross - center)
        if (cross >= lo && cross <= hi && distance < bestDistance) {
          best = cross
          bestDistance = distance
        }
      }
    }

    if (bestDistance === Infinity) {
      this.#edge = expected // flywheel: keep the byte count exact
    } else {
      const edge = best - this.windowLength / 2
      const measured = (edge - this.#edge) / BITS_PER_FRAME
      let next = period + CLOCK_GAIN * (measured - period)
      if (next < this.#minPeriod) next = this.#minPeriod
      else if (next > this.#maxPeriod) next = this.#maxPeriod
      this.#period = next
      this.#edge = edge
    }
    this.#byte = 0
    this.#scheduleBit(1)
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
