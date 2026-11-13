// Modulator: turns a Tape_Record into Kansas City Standard audio samples
// (design.md, "Modulator"; Requirement 4).
//
// Bit stream = leader mark bits ‖ 11-bit UART frame per record byte ‖ trailer mark bits
//
// - Each byte frame is a start bit 0, eight data bits LSB first, then two stop
//   bits 1, back to back with no idle bits (Requirement 4.1).
// - A 0 bit is 1,200 Hz and a 1 bit is 2,400 Hz (Requirement 4.2).
// - Bit k occupies samples [round(k · 44,100 / baud), round((k + 1) · 44,100 / baud)).
//   Every boundary is computed from k, never by adding a rounded per-bit length,
//   so 2,400 baud (18.375 samples per bit) does not drift.
// - One float64 phase accumulator runs through the whole signal. It starts at 0
//   and is never reset, so the tone is continuous at every bit boundary,
//   including leader to record and record to trailer.

import { InputError } from '../core/errors'

/**
 * Standard_Mode is 300 baud and Turbo_Mode is 2,400 baud. Defined here rather
 * than in `tape/framer.ts` because imports flow downward (`tape → modem`);
 * the framer re-exports it.
 */
export type BaudRate = 300 | 2400

/** Output sample rate in Hz. */
export const SAMPLE_RATE = 44_100
/** Peak tone amplitude as a fraction of full scale. */
export const AMPLITUDE = 0.7
/** Space tone (bit 0) in Hz. */
export const SPACE_HZ = 1_200
/** Mark tone (bit 1) in Hz. */
export const MARK_HZ = 2_400
/** Bits per byte frame: start, eight data bits, two stop bits. */
export const BITS_PER_FRAME = 11
/** Leader length in seconds of mark tone. */
export const LEADER_SECONDS = 2
/** Trailer length in seconds of mark tone. */
export const TRAILER_SECONDS = 0.5

const SPACE_STEP = (2 * Math.PI * SPACE_HZ) / SAMPLE_RATE
const MARK_STEP = (2 * Math.PI * MARK_HZ) / SAMPLE_RATE

function checkBaud(baud: BaudRate): void {
  if (baud !== 300 && baud !== 2400) throw new InputError('unsupported baud rate', baud)
}

/** Leader mark bits: 600 at 300 baud, 4,800 at 2,400 baud. */
export function leaderBits(baud: BaudRate): number {
  checkBaud(baud)
  return LEADER_SECONDS * baud
}

/** Trailer mark bits: 150 at 300 baud, 1,200 at 2,400 baud. */
export function trailerBits(baud: BaudRate): number {
  checkBaud(baud)
  return TRAILER_SECONDS * baud
}

/** First sample of bit `k`: round(k · 44,100 / baud). */
function bitStart(k: number, baud: BaudRate): number {
  return Math.round((k * SAMPLE_RATE) / baud)
}

/** Number of samples `modulate` returns for a record of `byteCount` bytes. */
export function modulatedLength(byteCount: number, baud: BaudRate): number {
  if (!Number.isInteger(byteCount) || byteCount < 0) throw new InputError('byte count must be a whole number', byteCount)
  const bits = leaderBits(baud) + BITS_PER_FRAME * byteCount + trailerBits(baud)
  return bitStart(bits, baud)
}

/**
 * Writes bit `k` with value `bit` into `out` and returns the advanced phase.
 * The sample is taken before the phase advances, so the signal starts at sin(0).
 */
function writeBit(out: Float32Array, k: number, baud: BaudRate, bit: number, phase: number): number {
  const start = bitStart(k, baud)
  const end = bitStart(k + 1, baud)
  const step = bit === 0 ? SPACE_STEP : MARK_STEP
  for (let n = start; n < end; n++) {
    out[n] = AMPLITUDE * Math.sin(phase)
    phase += step
  }
  return phase
}

/**
 * Modulates a Tape_Record into mono samples at 44,100 Hz with peak amplitude
 * 0.7, framed by 2.0 s of leader and 0.5 s of trailer mark tone
 * (Requirements 4.1 to 4.5).
 *
 * @throws InputError if `baud` is not 300 or 2,400
 */
export function modulate(record: Uint8Array, baud: BaudRate): Float32Array<ArrayBuffer> {
  const out = new Float32Array(modulatedLength(record.length, baud))
  const leader = leaderBits(baud)
  const trailer = trailerBits(baud)

  let phase = 0
  let k = 0
  for (let i = 0; i < leader; i++) phase = writeBit(out, k++, baud, 1, phase)
  for (let b = 0; b < record.length; b++) {
    const byte = record[b]!
    phase = writeBit(out, k++, baud, 0, phase) // start bit
    for (let i = 0; i < 8; i++) phase = writeBit(out, k++, baud, (byte >> i) & 1, phase)
    phase = writeBit(out, k++, baud, 1, phase) // stop bit 1
    phase = writeBit(out, k++, baud, 1, phase) // stop bit 2
  }
  for (let i = 0; i < trailer; i++) phase = writeBit(out, k++, baud, 1, phase)
  return out
}
