// Virtual_Tape_Channel: simulates playback from a worn cassette
// (design.md, "Virtual_Tape_Channel"; Requirements 6.3 and 6.4).
//
// Processing order, matching playback from a real tape:
// 1. Bandpass: 2nd-order Butterworth high-pass at 300 Hz, then 2nd-order
//    Butterworth low-pass at 5,000 Hz (RBJ biquads, Q = 1/√2, float64 state).
// 2. Wow and flutter: speed s(t) = 1 + wow · (0.8 · sin(2π · 0.5 · t) + 0.2 · sin(2π · 12 · t)),
//    with t the output time in seconds. The read position p starts at 0 and
//    advances by s(t) per output sample; each output sample is the linear
//    interpolation of the filtered input at p. Output ends when p passes the
//    last input sample.
// 3. Hiss: Gaussian white noise (Box-Muller on a seeded mulberry32) with
//    standard deviation hiss · 0.7 / √2, Hiss_Level times Nominal_Carrier_RMS.
// 4. Clamp to [−1, 1].
//
// The function is pure: the same samples, sample rate, and settings (including
// the seed) always give the same output (Requirement 6.4). The seeded PRNG
// drives only the simulated hiss.

import { InputError } from '../core/errors'
import { Biquad } from '../modem/biquad'
import { GaussianSource } from './prng'

/** Bandpass edges in Hz. */
export const HIGH_PASS_HZ = 300
export const LOW_PASS_HZ = 5_000

/** Largest Hiss_Level (60%) and Wow_Level (5%), as fractions. */
export const MAX_HISS = 0.6
export const MAX_WOW = 0.05

/** Nominal_Carrier_RMS: the RMS of a full-amplitude Modulator tone, 0.7 / √2. */
export const NOMINAL_CARRIER_RMS = 0.7 / Math.SQRT2

/** Lowest and highest sample rates accepted, the same range as the demodulator. */
export const MIN_SAMPLE_RATE = 22_050
export const MAX_SAMPLE_RATE = 96_000

/** Wow (0.5 Hz) and flutter (12 Hz) components of the speed curve. */
const WOW_HZ = 0.5
const WOW_WEIGHT = 0.8
const FLUTTER_HZ = 12
const FLUTTER_WEIGHT = 0.2

/** Output samples between exact recomputations of the speed oscillators. */
const OSCILLATOR_RESYNC = 4_096

export type TapeChannelSettings = {
  /** Hiss_Level, 0 to 0.6. */
  hiss: number
  /** Wow_Level, the peak speed deviation, 0 to 0.05. */
  wow: number
  /** Seed for the hiss noise; any safe integer. */
  seed: number
}

function checkSettings(sampleRate: number, settings: TapeChannelSettings): void {
  if (!Number.isFinite(sampleRate) || sampleRate < MIN_SAMPLE_RATE || sampleRate > MAX_SAMPLE_RATE) {
    throw new InputError('unsupported sample rate', sampleRate, 'Hz')
  }
  const { hiss, wow, seed } = settings
  if (!Number.isFinite(hiss) || hiss < 0 || hiss > MAX_HISS) throw new InputError('hiss level must be 0 to 0.6', hiss)
  if (!Number.isFinite(wow) || wow < 0 || wow > MAX_WOW) throw new InputError('wow level must be 0 to 0.05', wow)
  if (!Number.isSafeInteger(seed)) throw new InputError('seed must be a whole number')
}

/**
 * Passes `input` through the simulated tape: bandpass, wow and flutter, hiss,
 * then clamping (Requirement 6.3). The output length differs from the input
 * length when `wow` is above 0.
 *
 * @throws InputError if the sample rate or a setting is out of range
 */
export function applyTapeChannel(
  input: Float32Array,
  sampleRate: number,
  settings: TapeChannelSettings,
): Float32Array<ArrayBuffer> {
  checkSettings(sampleRate, settings)
  const { hiss, wow, seed } = settings
  const length = input.length
  if (length === 0) return new Float32Array(0)

  // 1. Bandpass in float64.
  const filtered = new Float64Array(input)
  Biquad.highPass(sampleRate, HIGH_PASS_HZ).processInPlace(filtered)
  Biquad.lowPass(sampleRate, LOW_PASS_HZ).processInPlace(filtered)

  // 2. Wow and flutter. At wow = 0 the speed is exactly 1, p lands on every
  // input sample, and interpolation returns the filtered samples unchanged.
  const out = wow === 0 ? new Float32Array(filtered) : resample(filtered, sampleRate, wow)

  // 3. Hiss.
  if (hiss > 0) new GaussianSource(seed).addScaledTo(out, hiss * NOMINAL_CARRIER_RMS)

  // 4. Clamp.
  for (let k = 0; k < out.length; k++) {
    const y = out[k]!
    if (y > 1) out[k] = 1
    else if (y < -1) out[k] = -1
  }
  return out
}

/**
 * Reads `filtered` at a position that advances by the speed s(t) per output
 * sample, with linear interpolation, until the position passes the last input
 * sample. `filtered` must not be empty and `wow` must be above 0.
 */
function resample(filtered: Float64Array, sampleRate: number, wow: number): Float32Array<ArrayBuffer> {
  // Speed never drops below 1 − wow, so this bounds the output length.
  const last = filtered.length - 1
  const capacity = Math.ceil(last / (1 - wow)) + 1
  const out = new Float32Array(capacity)

  // Both speed sinusoids run as rotating phasors (cos, sin), resynchronized
  // from Math.cos and Math.sin every OSCILLATOR_RESYNC samples to cancel drift.
  const wowStep = (2 * Math.PI * WOW_HZ) / sampleRate
  const flutterStep = (2 * Math.PI * FLUTTER_HZ) / sampleRate
  const wowRotCos = Math.cos(wowStep)
  const wowRotSin = Math.sin(wowStep)
  const flutterRotCos = Math.cos(flutterStep)
  const flutterRotSin = Math.sin(flutterStep)
  const wowGain = wow * WOW_WEIGHT
  const flutterGain = wow * FLUTTER_WEIGHT
  let wowCos = 1
  let wowSin = 0
  let flutterCos = 1
  let flutterSin = 0
  let untilResync = OSCILLATOR_RESYNC

  let p = 0
  let n = 0
  while (p <= last) {
    // p is non-negative and far below 2³¹, so `| 0` is floor.
    const i = p | 0
    const x0 = filtered[i]!
    out[n] = i === last ? x0 : x0 + (p - i) * (filtered[i + 1]! - x0)

    // s(t) at t = n / sampleRate.
    p += 1 + wowGain * wowSin + flutterGain * flutterSin
    n++
    if (--untilResync === 0) {
      untilResync = OSCILLATOR_RESYNC
      wowCos = Math.cos(wowStep * n)
      wowSin = Math.sin(wowStep * n)
      flutterCos = Math.cos(flutterStep * n)
      flutterSin = Math.sin(flutterStep * n)
    } else {
      const wc = wowCos * wowRotCos - wowSin * wowRotSin
      wowSin = wowSin * wowRotCos + wowCos * wowRotSin
      wowCos = wc
      const fc = flutterCos * flutterRotCos - flutterSin * flutterRotSin
      flutterSin = flutterSin * flutterRotCos + flutterCos * flutterRotSin
      flutterCos = fc
    }
  }
  return n === capacity ? out : out.slice(0, n)
}
