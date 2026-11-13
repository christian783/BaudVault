import { describe, expect, it } from 'vitest'
import { InputError } from '../core/errors'
import { Biquad } from './biquad'

const RATE = 44_100

/** Steady-state gain in dB of `filter` for a unit sine at `hz`, measured over the second half of 2 s. */
function gainDb(filter: Biquad, hz: number): number {
  const length = 2 * RATE
  const buffer = new Float64Array(length)
  for (let n = 0; n < length; n++) buffer[n] = Math.sin((2 * Math.PI * hz * n) / RATE)
  filter.processInPlace(buffer)
  let power = 0
  for (let n = length / 2; n < length; n++) power += buffer[n]! ** 2
  const rms = Math.sqrt(power / (length / 2))
  return 20 * Math.log10(rms / Math.SQRT1_2)
}

describe('Biquad (Butterworth, Q = 1/√2)', () => {
  it('is −3.01 dB at the cutoff of the 300 Hz high-pass and the 5,000 Hz low-pass', () => {
    expect(gainDb(Biquad.highPass(RATE, 300), 300)).toBeCloseTo(-3.01, 1)
    expect(gainDb(Biquad.lowPass(RATE, 5_000), 5_000)).toBeCloseTo(-3.01, 1)
  })

  it('passes the 1,200 Hz and 2,400 Hz tones with under 0.5 dB loss through the bandpass', () => {
    for (const hz of [1_200, 2_400]) {
      const hp = gainDb(Biquad.highPass(RATE, 300), hz)
      const lp = gainDb(Biquad.lowPass(RATE, 5_000), hz)
      expect(hp + lp).toBeGreaterThan(-0.5)
      expect(hp + lp).toBeLessThan(0.01)
    }
  })

  it('attenuates far outside the band by the 2nd-order slope', () => {
    // 12 dB per octave: two octaves away is about −24 dB or lower.
    expect(gainDb(Biquad.highPass(RATE, 300), 75)).toBeLessThan(-23)
    expect(gainDb(Biquad.lowPass(RATE, 5_000), 20_000)).toBeLessThan(-23)
  })

  it('gives the same result from step and from processInPlace', () => {
    const input = Float64Array.from({ length: 500 }, (_, n) => Math.sin(n * 0.37) + 0.3 * Math.cos(n * 2.1))
    const stepped = Biquad.lowPass(RATE, 5_000)
    const expected = Array.from(input, (x) => stepped.step(x))
    const block = Biquad.lowPass(RATE, 5_000)
    const buffer = Float64Array.from(input)
    block.processInPlace(buffer.subarray(0, 123))
    block.processInPlace(buffer.subarray(123))
    expect(Array.from(buffer)).toEqual(expected)
  })

  it('rejects a cutoff at or above half the sample rate', () => {
    expect(() => Biquad.lowPass(RATE, RATE / 2)).toThrow(InputError)
    expect(() => Biquad.highPass(RATE, 0)).toThrow(InputError)
  })
})
