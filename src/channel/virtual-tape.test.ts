import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { InputError } from '../core/errors'
import { open, seal } from '../crypto/vault'
import { type BaudRate, modulate, SAMPLE_RATE } from '../modem/kcs-modulator'
import { frame } from '../tape/framer'
import { type DecoderEvent, TapeDecoder } from '../tape/tape-decoder'
import { applyTapeChannel, NOMINAL_CARRIER_RMS } from './virtual-tape'

const RATE = 44_100

describe('applyTapeChannel (sanity)', () => {
  it('keeps the length without wow and changes it with wow', () => {
    const input = new Float32Array(RATE)
    expect(applyTapeChannel(input, RATE, { hiss: 0, wow: 0, seed: 1 }).length).toBe(RATE)
    // Over the first second the speed curve averages above 1, so the output is shorter.
    const wobbly = applyTapeChannel(input, RATE, { hiss: 0, wow: 0.05, seed: 1 }).length
    expect(wobbly).toBeLessThan(RATE)
    expect(wobbly).toBeGreaterThan(RATE * 0.95)
  })

  it('adds hiss with RMS equal to Hiss_Level times Nominal_Carrier_RMS', () => {
    const out = applyTapeChannel(new Float32Array(4 * RATE), RATE, { hiss: 0.3, wow: 0, seed: 5 })
    let power = 0
    for (const y of out) power += y * y
    expect(Math.sqrt(power / out.length) / (0.3 * NOMINAL_CARRIER_RMS)).toBeCloseTo(1, 1)
  })

  it('clamps the output to [−1, 1]', () => {
    const loud = new Float32Array(RATE).map((_, n) => Math.sin((2 * Math.PI * 1_200 * n) / RATE))
    const out = applyTapeChannel(loud, RATE, { hiss: 0.6, wow: 0.02, seed: 3 })
    expect(out.every((y) => y >= -1 && y <= 1)).toBe(true)
  })

  it('returns an empty array for empty input', () => {
    expect(applyTapeChannel(new Float32Array(0), RATE, { hiss: 0.3, wow: 0.02, seed: 0 }).length).toBe(0)
  })

  it.each([
    { hiss: -0.01, wow: 0, seed: 0 },
    { hiss: 0.61, wow: 0, seed: 0 },
    { hiss: Number.NaN, wow: 0, seed: 0 },
    { hiss: 0, wow: -0.01, seed: 0 },
    { hiss: 0, wow: 0.051, seed: 0 },
    { hiss: 0, wow: 0, seed: 0.5 },
  ])('rejects out-of-range settings %o', (settings) => {
    expect(() => applyTapeChannel(new Float32Array(10), RATE, settings)).toThrow(InputError)
  })

  it('rejects an unsupported sample rate', () => {
    expect(() => applyTapeChannel(new Float32Array(10), 8_000, { hiss: 0, wow: 0, seed: 0 })).toThrow(InputError)
  })
})

// ---------------------------------------------------------------------------
// Determinism (Requirement 6.4) and Standard_Mode recovery (Requirement 6.5).

/** Worst settings Requirement 6.5 covers: 30% hiss, 2% wow. */
const WORST = { hiss: 0.3, wow: 0.02 } as const

/** Fixed fast-check seed so a failure reproduces exactly. */
const FC_SEED = 0x7a9e_2026

function decodeAll(samples: Float32Array, baud?: BaudRate): DecoderEvent[] {
  const decoder = new TapeDecoder(baud === undefined ? { sampleRate: SAMPLE_RATE } : { sampleRate: SAMPLE_RATE, baud })
  const events: DecoderEvent[] = []
  for (let i = 0; i < samples.length; i += 2_048) events.push(...decoder.push(samples.subarray(i, i + 2_048)))
  return events
}

/** Frames, modulates at 300 baud, runs the channel, decodes, and returns the single recovered Body. */
function throughStandardTape(body: Uint8Array, seed: number, baud?: BaudRate): Uint8Array {
  const tape = modulate(frame(body, 'envelope', 300), 300)
  const events = decodeAll(applyTapeChannel(tape, SAMPLE_RATE, { ...WORST, seed }), baud)
  const errors = events.filter((event) => event.type === 'error')
  expect(errors, `seed ${seed}: error event`).toEqual([])
  const records = events.filter((event) => event.type === 'record')
  expect(records, `seed ${seed}: record count`).toHaveLength(1)
  const record = records[0]!
  if (record.type !== 'record') throw new Error('no record event')
  expect(record.header.baud).toBe(300)
  expect(record.stats.uncorrectableBlocks).toEqual([])
  return record.body
}

describe('applyTapeChannel determinism (Requirement 6.4)', () => {
  const tape = modulate(frame(new Uint8Array(24).map((_, i) => (i * 37 + 5) & 0xff), 'envelope', 300), 300)

  it('gives identical output for the same samples, settings, and seed', () => {
    const copy = tape.slice()
    const a = applyTapeChannel(tape, SAMPLE_RATE, { ...WORST, seed: 42 })
    const b = applyTapeChannel(copy, SAMPLE_RATE, { ...WORST, seed: 42 })
    expect(b).toEqual(a)
    // The input is left untouched, so a replay starts from the same samples.
    expect(tape).toEqual(copy)
  })

  it('gives different output for a different seed', () => {
    const a = applyTapeChannel(tape, SAMPLE_RATE, { ...WORST, seed: 42 })
    const b = applyTapeChannel(tape, SAMPLE_RATE, { ...WORST, seed: 43 })
    expect(b.length).toBe(a.length)
    let differing = 0
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) differing++
    // Hiss touches every sample, so almost all of them differ.
    expect(differing).toBeGreaterThan(a.length * 0.99)
  })
})

describe('Standard_Mode recovery through the channel at 30% hiss and 2% wow (Requirement 6.5)', () => {
  it('recovers random Bodies byte for byte across random seeds', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.integer({ min: -(2 ** 31), max: 2 ** 31 - 1 }),
        (body, seed) => {
          expect(throughStandardTape(body, seed, 300)).toEqual(body)
        },
      ),
      { seed: FC_SEED, numRuns: 8 },
    )
  })

  it('recovers a two-Codeword Body', () => {
    const body = new Uint8Array(300).map((_, i) => (i * 151 + 3) & 0xff)
    expect(throughStandardTape(body, 0x5eed, 300)).toEqual(body)
  })

  it('unlocks a sealed secret end to end with an auto-detecting decoder', async () => {
    const password = 'correct horse battery staple'
    const plaintext = new TextEncoder().encode('abandon ability able about above absent absorb abstract')
    const envelope = await seal(plaintext, password, { iterations: 1_000 })
    const recovered = throughStandardTape(envelope, 20_261_113)
    expect(recovered).toEqual(envelope)
    expect(await open(recovered, password)).toEqual(plaintext)
  })
})
