import { describe, expect, it } from 'vitest'
import { InputError } from '../core/errors'
import { type BaudRate, AMPLITUDE, leaderBits, modulate, modulatedLength, SAMPLE_RATE, trailerBits } from './kcs-modulator'

describe('modulate (sanity)', () => {
  it('uses 2.0 s of leader and 0.5 s of trailer', () => {
    expect(leaderBits(300)).toBe(600)
    expect(leaderBits(2400)).toBe(4_800)
    expect(trailerBits(300)).toBe(150)
    expect(trailerBits(2400)).toBe(1_200)
  })

  it.each<BaudRate>([300, 2400])('returns round(bits · 44100 / baud) samples at %i baud', (baud) => {
    const record = new Uint8Array([0x00, 0xff, 0x5a])
    const bits = leaderBits(baud) + 11 * record.length + trailerBits(baud)
    const out = modulate(record, baud)
    expect(out.length).toBe(Math.round((bits * SAMPLE_RATE) / baud))
    expect(out.length).toBe(modulatedLength(record.length, baud))
  })

  it('starts at sin(0), stays within the amplitude, and never jumps between samples', () => {
    const out = modulate(new Uint8Array([0x00, 0xff, 0x5a, 0xa5]), 2400)
    expect(out[0]).toBe(0)
    // The largest per-sample change of a continuous 2,400 Hz sine at 0.7 is
    // 0.7 · 2π · 2400 / 44100 ≈ 0.239. A phase reset at a boundary could exceed it.
    const maxStep = AMPLITUDE * ((2 * Math.PI * 2400) / SAMPLE_RATE) + 1e-6
    let peak = 0
    let largestStep = 0
    for (let n = 0; n < out.length; n++) {
      peak = Math.max(peak, Math.abs(out[n]!))
      if (n > 0) largestStep = Math.max(largestStep, Math.abs(out[n]! - out[n - 1]!))
    }
    expect(peak).toBeLessThanOrEqual(AMPLITUDE + 1e-6)
    expect(largestStep).toBeLessThanOrEqual(maxStep)
  })

  it('sends each byte as start 0, data LSB first, stop 1, stop 1 at 300 baud', () => {
    // At 300 baud a bit is 147 samples: 4 cycles of 1,200 Hz or 8 of 2,400 Hz.
    const byte = 0b1011_0010
    const out = modulate(new Uint8Array([byte]), 300)
    const expected = [0, ...Array.from({ length: 8 }, (_, i) => (byte >> i) & 1), 1, 1]
    const first = leaderBits(300)
    for (let i = 0; i < expected.length; i++) {
      const start = (first + i) * 147
      let crossings = 0
      for (let n = start + 1; n < start + 147; n++) {
        if (Math.sign(out[n]!) !== Math.sign(out[n - 1]!) && out[n] !== 0) crossings++
      }
      // 4 cycles give about 8 sign changes and 8 cycles about 16.
      expect(crossings > 12 ? 1 : 0).toBe(expected[i])
    }
  })

  it('rejects an unsupported baud rate', () => {
    expect(() => modulate(new Uint8Array(1), 1200 as BaudRate)).toThrow(InputError)
  })
})

describe('modulate at 2,400 baud (Turbo_Mode)', () => {
  /** The bit stream of design.md "Modulator": leader marks, 11-bit frames, trailer marks. */
  function bitStream(record: Uint8Array, baud: BaudRate): number[] {
    const bits: number[] = Array.from({ length: leaderBits(baud) }, () => 1)
    for (const byte of record) bits.push(0, ...Array.from({ length: 8 }, (_, i) => (byte >> i) & 1), 1, 1)
    for (let i = 0; i < trailerBits(baud); i++) bits.push(1)
    return bits
  }

  it('returns the exact sample count of the design formula', () => {
    // 4,800 leader + 11 · 3 + 1,200 trailer = 6,033 bits; 6,033 · 18.375 = 110,856.375.
    expect(modulate(new Uint8Array([0x00, 0xff, 0x5a]), 2400).length).toBe(110_856)
    // 6,000 bits of leader and trailer alone are exactly 2.5 s.
    expect(modulate(new Uint8Array(0), 2400).length).toBe(110_250)
    // A frame is 11 · 18.375 = 202.125 samples, so 8 frames are exactly 1,617 samples.
    expect(modulatedLength(8, 2400) - modulatedLength(0, 2400)).toBe(1_617)
  })

  it('switches tone exactly at the bit boundaries round(k · 44100 / 2400)', () => {
    // Rebuild the expected signal from the bit stream with its own phase accumulator.
    const record = new Uint8Array([0x00, 0xff, 0x5a, 0xa5, 0x01, 0x80])
    const bits = bitStream(record, 2400)
    const out = modulate(record, 2400)
    let phase = 0
    let worst = 0
    for (let k = 0; k < bits.length; k++) {
      const start = Math.round((k * 44_100) / 2400)
      const end = Math.round(((k + 1) * 44_100) / 2400)
      // Bits are 18 or 19 samples long, never 18.375 rounded and accumulated.
      expect(end - start === 18 || end - start === 19).toBe(true)
      const step = (2 * Math.PI * (bits[k] === 1 ? 2400 : 1200)) / SAMPLE_RATE
      for (let n = start; n < end; n++) {
        worst = Math.max(worst, Math.abs(out[n]! - AMPLITUDE * Math.sin(phase)))
        phase += step
      }
    }
    expect(worst).toBeLessThan(1e-6)
  })

  it('sends one cycle of 2,400 Hz for a 1 and half a cycle of 1,200 Hz for a 0, start 0, data LSB first, stop 1, stop 1', () => {
    // Total variation within one bit: a full cycle at 0.7 sweeps about 4 · 0.7 = 2.8,
    // half a cycle sweeps about 2 · 0.7 = 1.4.
    const record = new Uint8Array([0b1011_0010, 0x00, 0xff])
    const out = modulate(record, 2400)
    const expected = bitStream(record, 2400).slice(leaderBits(2400), leaderBits(2400) + 11 * record.length)
    const decided = expected.map((_, i) => {
      const k = leaderBits(2400) + i
      const start = Math.round((k * 44_100) / 2400)
      const end = Math.round(((k + 1) * 44_100) / 2400)
      let variation = 0
      for (let n = start + 1; n < end; n++) variation += Math.abs(out[n]! - out[n - 1]!)
      return variation > 2 ? 1 : 0
    })
    expect(decided).toEqual(expected)
    expect(expected.slice(0, 11)).toEqual([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1])
  })
})
