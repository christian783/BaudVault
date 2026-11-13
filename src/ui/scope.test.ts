import { describe, expect, it } from 'vitest'
import { playbackSamples } from '../audio/playback'
import { modulate, SAMPLE_RATE } from '../modem/kcs-modulator'
import { frame } from '../tape/framer'
import { TapeDecoder } from '../tape/tape-decoder'
import { energyFraction, frameDue, MIN_FRAME_MS, traceBands, traceX, traceY } from './scope'

describe('trace geometry (Requirement 7.2)', () => {
  const { a, b } = traceBands(320)

  it('puts trace A in the upper half and trace B in the lower half', () => {
    expect(a).toEqual({ top: 0, height: 160 })
    expect(b).toEqual({ top: 160, height: 160 })
  })

  it('maps +1, 0, and −1 inside the band, +1 on top, and clamps out-of-range values', () => {
    expect(traceY(0, b)).toBe(240)
    expect(traceY(1, b)).toBeCloseTo(160 + 160 * 0.08)
    expect(traceY(-1, b)).toBeCloseTo(320 - 160 * 0.08)
    expect(traceY(5, a)).toBe(traceY(1, a))
    expect(traceY(-5, a)).toBe(traceY(-1, a))
    expect(traceY(Number.NaN, a)).toBe(traceY(0, a))
  })

  it('spreads the samples across the full width', () => {
    expect(traceX(0, 882, 640)).toBe(0)
    expect(traceX(881, 882, 640)).toBe(640)
    expect(traceX(0, 1, 640)).toBe(0)
  })
})

describe('energyFraction (Requirement 7.3)', () => {
  it('is 0 at −60 dB and below, 1 at full scale, and about 0.95 for a 0.7 tone', () => {
    expect(energyFraction(0)).toBe(0)
    expect(energyFraction(1e-7)).toBe(0)
    expect(energyFraction(1e-6)).toBeCloseTo(0)
    expect(energyFraction(1)).toBe(1)
    expect(energyFraction(4)).toBe(1)
    expect(energyFraction(0.49)).toBeCloseTo(0.948, 2)
    expect(energyFraction(Number.NaN)).toBe(0)
  })
})

describe('frameDue (Requirement 7.4)', () => {
  it('draws at most 60 frames per second on fast displays and every frame at 60 Hz', () => {
    const draw = (interval: number, frames: number) => {
      let last: number | null = null
      let drawn = 0
      for (let i = 0; i < frames; i++) {
        const now = i * interval
        if (frameDue(now, last)) {
          last = now
          drawn++
        }
      }
      return drawn
    }
    expect(draw(1000 / 60, 60)).toBe(60)
    expect(draw(1000 / 120, 120)).toBe(60)
    expect(draw(1000 / 144, 144)).toBeLessThanOrEqual(60)
    expect(MIN_FRAME_MS).toBeLessThan(1000 / 60)
  })
})

describe('trace A with the Virtual_Tape_Channel on (Requirement 7.5)', () => {
  it('shows the processed samples that Play sends to the decoder, not the Modulator output', () => {
    const clean = modulate(frame(new Uint8Array([1, 2, 3]), 'envelope', 2400), 2400).subarray(0, 44_100)
    const processed = playbackSamples(clean.slice(), SAMPLE_RATE, { hiss: 0.3, wow: 0.02, seed: 7 })
    const decoder = new TapeDecoder({ sampleRate: SAMPLE_RATE })
    decoder.push(processed)

    const trace = new Float32Array(decoder.scope.size)
    decoder.scope.readInput(trace)
    expect(trace).toEqual(processed.subarray(processed.length - trace.length))
    expect(trace).not.toEqual(clean.subarray(processed.length - trace.length, processed.length))
  })
})
